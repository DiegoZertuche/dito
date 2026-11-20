// Package historyspike is the on-demand history REQUEST and the rig-only
// probe built around it.
//
// THE PROBE came first (ticket #216): does the phone answer an on-demand
// history request for a chat from the anchor the seam already holds? Slice
// 6a's scoping page promises a scoped chat's last ninety days, and the plane's
// fill pages backwards from that anchor — so the one library path the whole
// design rests on was proven on a real phone before anything was built on it.
// It answered yes on 2026-09-07, and the plane's `--history-spike-chat` mode
// is the instrument that got there.
//
// THE REQUEST HAS A SECOND CALLER SINCE THAT ANSWER (ticket #222): the
// ninety-day fill, `plane/fill`, which sends the same request this package
// builds (BuildRequest, Request) and reads an answer by the same rule
// (MatchConversation). What it reuses is exported and what it does not is not:
// the MODE — its flags, its knobs, its trace, its findings — stays the rig's
// instrument, and nothing in the fill turns any of it.
//
// IT PROBES, IT NEVER CAPTURES. Nothing here writes a seam row, and nothing
// here reaches the ingest path: the answer is counted and thrown away. What
// the mode prints is metadata only — how many messages came back, the oldest
// instant, the sync type, the protocol's own refusal code — because content
// crosses the socket only DEK-encrypted (ADR-0008) and the plane's telemetry
// is content-free by construction (ADR-0025). The one identity it names is
// the chat the operator asked about. Everything this package prints holds to
// that, the verbose lane included (Trace); the one thing that does not is
// whatsmeow's own DEBUG log, which the operator turns on knowingly and which
// the flag's own words warn about.
//
// The anchor comes from the seam in plane custody (ADR-0008: the plane
// process is one of the DEK's exactly-two custody points), which is why this
// lives in the plane and not in a script: WhatsApp allows one live websocket
// per linked device, so nothing outside the plane binary can open the rig's
// session while the plane holds it.
package historyspike

import (
	"fmt"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// ParseChat reads the chat the operator asked about, and INSISTS ON A FULL
// JID because whatsmeow's parser does not: `ParseJID` reads a bare phone
// number as a SERVER with no user and reports no error, so
// `--history-spike-chat=5215551234567` — the obvious mistype — would send
// the spike asking about a chat nobody has, and the operator would read
// "the seam holds no message for this chat" as a finding about the rig.
// A rig session costs a stopped plane and a phone held online; it is not
// spent on a missing `@s.whatsapp.net`.
//
// The device suffix is dropped: the chat is the conversation, never one of
// its devices, and the seam keys rows by the bare identity (ingest's
// canonicalDMChat).
func ParseChat(spelling string) (types.JID, error) {
	chat, err := types.ParseJID(spelling)
	if err != nil {
		return types.JID{}, fmt.Errorf("%q is not a chat JID: %w", spelling, err)
	}
	if chat.User == "" || chat.Server == "" {
		return types.JID{}, fmt.Errorf("%q is not a full chat JID — it needs a user and a server, as in 5215551234567@%s", spelling, types.DefaultUserServer)
	}
	return chat.ToNonAD(), nil
}

// Anchor is what the seam already holds of a chat's newest message: the
// rail's own stanza id, the direction, and the instant the row records. The
// three facts the library's history request asks for, and nothing else —
// the payload they were read from never leaves the plane.
type Anchor struct {
	MessageID string
	FromMe    bool
	At        time.Time
}
