// Package linksession holds the plane's link session: the stretch in which an
// unlinked plane offers WhatsApp a QR and, when a rep asks, a pairing code
// (ADR-0005 job 3; ADR-0031's ~160-second window; ticket #403).
//
// A LINK SESSION IS OPENED, IT ENDS, AND THE PLANE GOES BACK TO WAITING. The
// library closes a session on its own clock — the QR codes run out and the
// login socket is closed — and that ending is a rail fact (`logged_out` with
// the library's own word for why), never the plane's ending. The next
// `pairing_code` request opens a fresh session on the same process, so a rep
// who missed one window, or whose device WhatsApp logged out while the plane
// ran, asks again from the dashboard and nobody restarts anything.
//
// ONLY TWO THINGS OPEN ONE: the plane starting with no persisted session (the
// operator's QR on the terminal), and a rep's `pairing_code` request. A plane
// that lost its session does not start linking on its own; it waits to be
// asked.
//
// AND ONE IS OPEN AT A TIME. The library binds a session to one QR channel on
// one socket, so an ask that arrives while a session stands is served inside
// it rather than opening a second.
package linksession

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/whatsmeow"

	"github.com/Dito-Core/dito/plane/bounded"
)

// Library is the part of one whatsmeow client a link session drives —
// *whatsmeow.Client in the binary. The QR channel must be asked for BEFORE the
// socket connects (whatsmeow's GetQRChannel contract), which is the order Open
// keeps.
type Library interface {
	GetQRChannel(ctx context.Context) (<-chan whatsmeow.QRChannelItem, error)
	Connect() error
}

// Rail records what a link session does on the seam — *rail.Rail in the
// binary, the one translator of library events into rail status rows.
type Rail interface {
	HandleQRItem(item whatsmeow.QRChannelItem)
	HandleLinkFailure(reason string) bool
}

// Config wires a Session.
type Config struct {
	Library Library
	Rail    Rail
	// Logf receives the operator's lines; content-free by construction, since
	// nothing here holds a number or a chat.
	Logf func(format string, args ...any)
	// Spoiled is told when the library's client cannot be trusted to
	// open a session — a dial it refused or never answered, or a pairing
	// that failed part way. The
	// binary replaces the client (`cmd/plane` argues why a fresh one rather
	// than another dial on this one). It must not block.
	Spoiled func(reason string)
	// Wait overrides readyTimeout; zero takes the argued default.
	Wait time.Duration
}

// readyTimeout bounds how long an ask waits for a fresh session's first QR,
// which is the library's signal that the login socket is up and a pairing
// code may be asked for (PairPhone's own comment: "wait for *events.QR").
//
// Thirty seconds is the plane's rail-write budget tripled: the dial, the noise
// handshake and the server's first QR reference each cost a round trip, and a
// session that has not offered a code by then leaves the rep most of their
// window to ask again.
const readyTimeout = 30 * time.Second

// ErrSessionEnded is an ask that was waiting on a session the library closed
// before it offered a code.
var ErrSessionEnded = errors.New("the link session ended before it offered a code")

// Session opens link sessions and says when one is ready for a pairing code.
type Session struct {
	cfg Config
	// life is what every session's channel lives under. It is the CLIENT'S and
	// never an ask's: the library closes the channel and the socket when that
	// context ends, so a session opened under a request's budget would close
	// the moment its code was served.
	life context.Context

	mu sync.Mutex
	// open is the standing session, or nil while the plane waits to be asked.
	open *standing
}

// standing is one open session's three signals: its first code, its end, and
// the moment its end is on the seam and the next session may open.
type standing struct {
	ready     chan struct{}
	readyOnce sync.Once
	ended     chan struct{}
	endOnce   sync.Once
	done      chan struct{}
	doneOnce  sync.Once
	cancel    context.CancelFunc
	// abandoned is set when the dial failed: whatever the library still writes
	// to this channel belongs to a client the plane has given up on, and
	// recording it would put a QR on the seam that no socket stands behind.
	abandoned atomic.Bool
}

func (s *standing) markReady() { s.readyOnce.Do(func() { close(s.ready) }) }

func (s *standing) markEnded() { s.endOnce.Do(func() { close(s.ended) }) }

func (s *standing) markDone() { s.doneOnce.Do(func() { close(s.done) }) }

// New builds a Session with nothing open, whose sessions live until life ends.
func New(life context.Context, cfg Config) *Session {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	return &Session{cfg: cfg, life: life}
}

func (s *Session) wait() time.Duration {
	if s.cfg.Wait > 0 {
		return s.cfg.Wait
	}
	return readyTimeout
}

// Open starts a link session unless one stands, and returns without waiting
// for its first code. The binary calls it once, at a start with no persisted
// session.
func (s *Session) Open(ctx context.Context) error {
	_, err := s.ensure(ctx)
	return err
}

// Ready opens a session unless one stands, then waits until it has offered
// its first code — the moment a pairing code may be asked for.
//
// A SESSION THAT ENDS WHILE AN ASK WAITS IS THAT ASK'S FAILURE, and the next
// ask opens another: the rep is told it failed and asks again, which is
// cheaper than a plane that retries into a window nobody is watching.
func (s *Session) Ready(ctx context.Context) error {
	session, err := s.ensure(ctx)
	if err != nil {
		return err
	}
	// AN END ALREADY SEEN OUTRANKS A CODE ALREADY OFFERED: both channels are
	// closed for a session that offered codes and then ran out, and a select
	// over the two would pick either.
	select {
	case <-session.ended:
		return ErrSessionEnded
	default:
	}
	timer := time.NewTimer(s.wait())
	defer timer.Stop()
	select {
	case <-session.ready:
		return nil
	case <-session.ended:
		return ErrSessionEnded
	case <-timer.C:
		// A SOCKET THAT CONNECTED AND NEVER OFFERED A CODE IS ABANDONED (Codex
		// r3): the library's own clock starts at its first QR, so a session
		// that never sees one would stand for ever and every later ask would
		// wait on it in turn.
		s.abandon(session, "no-code")
		return fmt.Errorf("the link session offered no code within %s", s.wait())
	case <-ctx.Done():
		return ctx.Err()
	}
}

// abandon gives up on a standing session the library has not ended: it is
// cleared under the lock, its end recorded, and the client reported spoiled,
// because the channel's listener stays registered on it (`ensure` argues why
// that client cannot open the next session).
func (s *Session) abandon(session *standing, reason string) {
	s.mu.Lock()
	if s.open != session {
		s.mu.Unlock()
		return
	}
	session.abandoned.Store(true)
	session.markEnded()
	s.open = nil
	s.cfg.Rail.HandleLinkFailure(reason)
	s.mu.Unlock()
	session.cancel()
	session.markDone()
	if s.cfg.Spoiled != nil {
		s.cfg.Spoiled("link session offered no code")
	}
}

// WhileStanding runs record only while a link session stands, and holds the
// session's end off until record returns.
//
// IT IS HOW A CREDENTIAL REACHES THE SEAM. The library can close a session at
// any instant — between a code coming back from the hello and that code's row
// being written — and a `pairing_code` row landing after the session's
// `logged_out` would read on the page as a new session with a live code on a
// socket that is gone. Under the lock `follow` records an end under, the two
// rows land in the order things happened, or the code is refused.
func (s *Session) WhileStanding(record func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.open == nil {
		return ErrSessionEnded
	}
	select {
	case <-s.open.ended:
		return ErrSessionEnded
	default:
	}
	return record()
}

// ensure answers the standing session, opening one when none stands.
//
// THE LOCK IS HELD ACROSS THE OPEN, so two callers cannot each find nothing
// standing and each ask the library for a QR channel: the library refuses the
// second only once the first is connected, and between the two calls it would
// hand out two channels for one socket.
//
// A SESSION THAT HAS ENDED IS WAITED OUT until its end is on the seam, so the
// rows read in the order things happened: the old session's `logged_out`
// before the new one's first QR, never after it — where it would claim the
// new session had ended.
func (s *Session) ensure(ctx context.Context) (*standing, error) {
	s.mu.Lock()
	for s.open != nil {
		open := s.open
		select {
		case <-open.ended:
		default:
			s.mu.Unlock()
			return open, nil
		}
		s.mu.Unlock()
		select {
		case <-open.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(s.wait()):
			return nil, errors.New("the last link session has not finished ending")
		}
		s.mu.Lock()
	}
	defer s.mu.Unlock()
	sessionCtx, cancel := context.WithCancel(s.life)
	qr, err := s.channel(ctx, sessionCtx)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("opening a link session: %w", err)
	}
	session := &standing{
		ready:  make(chan struct{}),
		ended:  make(chan struct{}),
		done:   make(chan struct{}),
		cancel: cancel,
	}
	s.open = session
	// THE CHANNEL IS READ BEFORE THE SOCKET CONNECTS, because the library
	// writes to it from its own event dispatch and that write blocks while
	// nobody reads: a reader started after the dial could stall the very
	// events that end the session.
	go s.follow(session, qr)
	// THE DIAL IS BOUNDED BY THIS PROCESS (`plane/bounded` argues why a
	// context is not a bound here): Connect dials on the library's own context
	// and a stalled upgrade returns to nobody.
	_, err = bounded.Call(ctx, s.wait(), "the rail's link-session dial",
		func(context.Context) (struct{}, error) { return struct{}{}, s.cfg.Library.Connect() })
	if err != nil {
		// NO SESSION STANDS, AND THIS CLIENT CANNOT OPEN THE NEXT ONE. The
		// library registered the channel's listener on the client and offers no
		// way to remove it from outside; left there, it would wake on the next
		// session's first QR and, its context done, close that session's socket.
		// So the session is abandoned here and the client is reported spoiled.
		session.abandoned.Store(true)
		cancel()
		s.open = nil
		s.cfg.Rail.HandleLinkFailure("dial-failed")
		session.markEnded()
		session.markDone()
		if s.cfg.Spoiled != nil {
			s.cfg.Spoiled("link-session dial failed")
		}
		return nil, fmt.Errorf("connecting the link session: %w", err)
	}
	s.cfg.Logf("link session open: QR follows, and a pairing code when the rep asks")
	return session, nil
}

// channel asks the library for a fresh QR channel.
//
// A SOCKET STILL CLOSING IS WAITED OUT, briefly. When the library ends a
// session on its own clock it closes the channel first and the socket after,
// on the same goroutine — so an ask that arrives in between finds the client
// still connected and is refused `ErrQRAlreadyConnected` for a socket that is
// a moment from gone.
func (s *Session) channel(ctx, sessionCtx context.Context) (<-chan whatsmeow.QRChannelItem, error) {
	deadline := time.Now().Add(closingGrace)
	for {
		qr, err := s.cfg.Library.GetQRChannel(sessionCtx)
		if !errors.Is(err, whatsmeow.ErrQRAlreadyConnected) || time.Now().After(deadline) {
			return qr, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(closingGrace / 10):
		}
	}
}

// closingGrace is how long `channel` waits out a closing socket: the library
// closes it right after the channel, so anything longer is a socket that is
// not closing.
const closingGrace = 2 * time.Second

// follow reads one session's channel to its close and records what it says.
//
// THE CHANNEL CLOSING IS THE LIBRARY'S ONE TERMINAL SIGNAL — individual items
// (a rescan, a passkey error) keep it open — so the session is over exactly
// when it closes, and the rail's own linked state decides whether that end is
// a failure (`rail.HandleLinkFailure` argues why the device JID cannot).
func (s *Session) follow(session *standing, qr <-chan whatsmeow.QRChannelItem) {
	paired := false
	lastEvent := "closed"
	for item := range qr {
		if session.abandoned.Load() {
			continue
		}
		s.cfg.Rail.HandleQRItem(item)
		lastEvent = item.Event
		switch item.Event {
		case whatsmeow.QRChannelEventCode:
			session.markReady()
		case whatsmeow.QRChannelSuccess.Event:
			paired = true
			s.cfg.Logf("link session: pairing succeeded, establishing session")
		case whatsmeow.QRChannelEventPasskeyRequest, whatsmeow.QRChannelEventPasskeyResponse:
			// The plane implements no WebAuthn authenticator, so a
			// passkey-gated link can never reach PairSuccess here. The session
			// is ended through its context, which is how the library closes a
			// channel whose codes are running; the close below then finds the
			// failure already recorded.
			s.cfg.Logf("link session: passkey step (%s) required — unsupported by the plane; ask again and link by QR or code", item.Event)
			session.markEnded()
			s.cfg.Rail.HandleLinkFailure("passkey-unsupported")
			session.cancel()
		case whatsmeow.QRChannelScannedWithoutMultidevice.Event:
			s.cfg.Logf("link session: scanned without multi-device — enable it on the rep's device and scan again")
		default:
			s.cfg.Logf("link session: %s", item.Event)
		}
	}
	if session.abandoned.Load() {
		return
	}
	// ENDED FIRST, so an ask arriving now waits for this session's end to be
	// recorded rather than pairing into a socket that is going; then the
	// record and the clearing under the lock `ensure` opens under, so no
	// session can open between the two.
	session.markEnded()
	s.mu.Lock()
	if !paired {
		s.cfg.Rail.HandleLinkFailure(lastEvent)
		s.cfg.Logf("link session ended without pairing (%s) — waiting for the next pairing code ask", lastEvent)
	}
	if s.open == session {
		s.open = nil
	}
	s.mu.Unlock()
	session.cancel()
	session.markDone()
	// A PAIRING THAT FAILED PART WAY SPOILS THE CLIENT (Codex r2). The library
	// assigns the device its identity before it saves it, and a save that fails
	// ends the session with an error item while the identity stays on the
	// device in memory — so this client would answer every later ask
	// `already_linked` for a session that exists nowhere. The binary replaces
	// it with one built over what the store actually holds.
	if !paired && lastEvent == whatsmeow.QRChannelEventError && s.cfg.Spoiled != nil {
		s.cfg.Spoiled("link-session pairing failed")
	}
}
