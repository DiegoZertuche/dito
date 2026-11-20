package historyspike

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// Edge is which end of the captured span the anchor comes from, and it is
// the knob the protocol run turns after runs 1 through 3 got silence (#216).
//
// WHY IT MATTERS. The request asks for the messages immediately BEFORE the
// anchor, and runs 1 through 3 anchored on the chat's newest message — which
// this companion had already been given by its own initial sync. A primary
// that will not resend what it has already transferred to a device answers
// such a request with nothing at all: no history, no refusal, no code, which
// is exactly what the rig saw. Anchoring on the OLDEST message the seam holds
// asks instead for messages this device has never received, which is the one
// version of the question the initial sync cannot already have answered.
type Edge string

const (
	// EdgeNewest anchors on the chat's newest captured message — what runs 1
	// through 3 asked with, and the default, so a run measures the change it
	// is testing and not a moved default.
	EdgeNewest Edge = "newest"
	// EdgeOldest anchors on the oldest captured message, reaching for what
	// the companion was never sent.
	EdgeOldest Edge = "oldest"
)

// ParseEdge reads the option's value and takes nothing but the two words.
func ParseEdge(spelling string) (Edge, error) {
	switch Edge(spelling) {
	case EdgeNewest:
		return EdgeNewest, nil
	case EdgeOldest:
		return EdgeOldest, nil
	default:
		return "", fmt.Errorf("%q is not an anchor end — it is %q or %q", spelling, EdgeNewest, EdgeOldest)
	}
}

// ErrNoAnchor marks a chat the seam holds no message for — the one honest
// reason the spike cannot even ask. It is not a finding about the library
// path under test, so the mode exits on it in its own words rather than
// reporting a timeout the phone never caused.
var ErrNoAnchor = errors.New("the seam holds no captured message for this chat")

// anchorEventType is the seam kind an anchor may come from, and it is the
// only one (ADR-0042 names three).
//
// A 'reaction' row states the GESTURE's own stanza id, which is not a
// position in the chat's message history — the phone is asked for the
// messages immediately before a message. An 'opaque' row states a COMPOSED
// identity (`<stanza>:opaque`, or `opaque:<hash>` where the rail supplied no
// id at all), which is not a rail id the phone could find. So the anchor is
// the newest MESSAGE, which is what the request means by its oldest message
// — and a chat whose last beats are photos still has one, a little further
// back, which the phone pages from just as well.
const anchorEventType = "message"

// payloadVersion is the seam's transport version, and the anchor refuses
// anything else rather than reading unknown fields as if it understood them
// (ADR-0034: the seam refuses what it cannot read).
const payloadVersion = 1

// Opener opens one DEK envelope blob — *ingest.Sealer in the binary, which
// holds the twin's unwrapped DEK inside the plane process (ADR-0008's
// exactly-two custody points).
type Opener interface {
	Open(blob []byte) ([]byte, error)
}

// Seam is the spike's read side: the plane's own seam connection, the twin
// whose rows it may read, and the custody that opens one of them. Read-only
// by construction — there is no write anywhere in this package.
type Seam struct {
	DB     *sql.DB
	Opener Opener
	TwinID string
}

// anchorRow is the little of the pinned v:1 message payload an anchor needs
// (packages/seam/src/wa-payload.ts, plane/ingest's payload struct): the
// rail's stanza id and the direction. THE TEXT AND THE PUSH NAME ARE NOT
// DECODED — a struct that named them would put the rep's content in a
// variable this command could print by accident, and the request has no use
// for either.
type anchorRow struct {
	V         int    `json:"v"`
	MessageID string `json:"message_id"`
	FromMe    bool   `json:"from_me"`
}

// Anchor reads one captured message off the seam — the newest or the oldest
// the chat holds (Edge says why either) — and opens THAT ONE payload in plane
// custody.
//
// THE SELF-CHAT IS AN ORDINARY CHAT HERE, and it is the one the protocol run
// asks about: the twin thread's rows are keyed by the rep's own JID like any
// other chat's, its scope is structural rather than an allowlist row
// (ADR-0023), and every message in it is `from_me` — a direction the request
// carries as readily as the other (a test at the seam pins all three).
//
// The chat is selected on the row's own plaintext identity —
// external_event_id is `<chat>:<stanza id>`, and the chat identities the
// seam keys by are bare (ingest's canonicalDMChat calls ToNonAD, so no
// device suffix and no colon can appear in one), which is what makes the
// prefix plus the separator name exactly one chat. It is the same predicate
// the runtime's extraction pass reads a chat's window by. The instant comes
// from occurred_at, the delivery's own instant, which is what the request
// asks for; the payload is opened only for the two facts the plaintext
// columns cannot state.
func (s Seam) Anchor(ctx context.Context, chat types.JID, edge Edge) (Anchor, error) {
	var occurredAt time.Time
	var payloadEnc []byte
	// The two ends are one query with its order reversed, and the order is
	// composed here rather than parameterized because a placeholder cannot
	// carry a sort direction. `edge` is one of two constants — ParseEdge
	// refuses everything else — so no operator value reaches this string.
	order := "DESC"
	if edge == EdgeOldest {
		order = "ASC"
	}
	err := s.DB.QueryRowContext(ctx,
		`SELECT occurred_at, payload_enc
		   FROM wa_events
		  WHERE twin_id = $1
		    AND event_type = $2
		    AND left(external_event_id, length($3::text) + 1) = $3 || ':'
		  ORDER BY occurred_at `+order+`, id `+order+`
		  LIMIT 1`,
		s.TwinID, anchorEventType, chat.String(),
	).Scan(&occurredAt, &payloadEnc)
	if errors.Is(err, sql.ErrNoRows) {
		return Anchor{}, fmt.Errorf("%w: %s", ErrNoAnchor, chat)
	}
	if err != nil {
		return Anchor{}, fmt.Errorf("reading the chat's %s captured message: %w", edge, err)
	}
	plaintext, err := s.Opener.Open(payloadEnc)
	if err != nil {
		return Anchor{}, fmt.Errorf("opening the anchor's payload in plane custody: %w", err)
	}
	var row anchorRow
	if err := json.Unmarshal(plaintext, &row); err != nil {
		// The decoder's own error is NOT carried: it quotes the bytes it
		// choked on, and those bytes are the rep's content (ADR-0008/0025).
		return Anchor{}, errors.New("the anchor row's payload does not read as the pinned seam envelope")
	}
	if row.V != payloadVersion {
		return Anchor{}, fmt.Errorf("the anchor row's payload is v:%d, and this mode reads v:%d", row.V, payloadVersion)
	}
	if row.MessageID == "" {
		return Anchor{}, errors.New("the anchor row's payload states no message id — nothing the phone could page back from")
	}
	return Anchor{MessageID: row.MessageID, FromMe: row.FromMe, At: occurredAt.UTC()}, nil
}
