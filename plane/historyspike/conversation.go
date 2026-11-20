package historyspike

import (
	"strings"

	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
)

// Which identity FORM the phone filed the answering conversation under.
//
// THIS IS THE FINDING THIS INSTRUMENT WAS BUILT WRONG FOR (#216). Every
// LID-addressed answer carried messages — whatsmeow stored 27 message
// secrets from the same blob for the oldest anchor and 36 for the newest, on
// three devices in a row — while the finding read `messages=0`, because the
// match compared the conversation's identity against the PN-canonical chat
// alone and the phone keys it by LID. A blob that does not match must
// therefore SAY it did not match, rather than reading as an empty answer.
const (
	convKeyPN        = "pn"
	convKeyLID       = "lid"
	convKeyUnmatched = "unmatched"
)

// ConversationMatch is what one conversation in an answer says about which
// chat it is, and whether that is the chat asked about. Content-free by
// construction: a form, and two statements of presence.
//
// EXPORTED FOR THE FILL (ticket #222). Reading an answer is the same question
// for the rig instrument and for the ninety-day fill — which chat is this, and
// under which of its names — so the rule is CALLED from both rather than
// copied into the second, where the two would drift apart over exactly the
// thing this file exists to get right.
type ConversationMatch struct {
	Matched   bool
	Key       string
	PNStated  bool
	LIDStated bool
}

// MatchConversation decides whether one conversation is the chat asked
// about, KNOWING THE CHAT BY BOTH ITS NAMES: the PN-canonical identity the
// seam holds and the trace prints, and the identity the request addressed —
// the counterparty's LID when the run asked that way (AddressChat).
//
// The phone may state the identity as the conversation's own key, as its
// `pnJID`, or as its `lidJID`, with or without a device part, so every
// stated form is parsed and compared bare (ToNonAD) — a device part on
// either side decides nothing. An unparseable value matches nothing rather
// than being compared as a string.
func MatchConversation(conv *waHistorySync.Conversation, pn, addressed types.JID) ConversationMatch {
	id, idOK := bareJID(conv.GetID())
	statedPN, pnOK := bareJID(conv.GetPnJID())
	statedLID, lidOK := bareJID(conv.GetLidJID())

	match := ConversationMatch{
		PNStated:  conv.GetPnJID() != "",
		LIDStated: conv.GetLidJID() != "",
		Key:       convKeyUnmatched,
	}
	for _, stated := range []struct {
		jid types.JID
		ok  bool
	}{{id, idOK}, {statedPN, pnOK}, {statedLID, lidOK}} {
		if stated.ok && isEither(stated.jid, pn, addressed) {
			match.Matched = true
			break
		}
	}
	if !match.Matched {
		return match
	}
	// WHICH FORM THE PHONE CHOSE is the conversation's own key, not the
	// alternative it also stated: that is the fact the fill needs, because it
	// decides which identity a later request must name.
	match.Key = convKeyPN
	if idOK && id.Server == types.HiddenUserServer {
		match.Key = convKeyLID
	}
	return match
}

// bareJID parses one stated identity into its bare form; ok is false when
// the conversation stated none or stated something that is not a JID.
//
// THE SPELLING IS CHECKED BEFORE IT IS PARSED (Codex r1). whatsmeow's
// ParseJID splits on "@" and keeps the first two segments, silently ignoring
// anything after the second — so «<the chat>@s.whatsapp.net@anything» parses
// to the chat itself and would match it. Reading that as the chat asked
// about would count another conversation's messages as this one's, which is
// the exact corruption this rule exists to end: one separator, or nothing.
func bareJID(spelling string) (types.JID, bool) {
	if spelling == "" || strings.Count(spelling, "@") != 1 {
		return types.JID{}, false
	}
	parsed, err := types.ParseJID(spelling)
	if err != nil {
		return types.JID{}, false
	}
	bare := parsed.ToNonAD()
	if bare.User == "" || bare.Server == "" {
		return types.JID{}, false
	}
	return bare, true
}

// isEither reports whether one stated identity is one of the chat's two
// names. Both sides are compared bare, so a device part on either decides
// nothing.
func isEither(stated types.JID, names ...types.JID) bool {
	for _, name := range names {
		if !name.IsEmpty() && stated == name.ToNonAD() {
			return true
		}
	}
	return false
}

// stated renders a presence as the lines say it.
func statedYesNo(present bool) string {
	if present {
		return "yes"
	}
	return "no"
}
