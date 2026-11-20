// Package pairing serves the pairing-code request: link day on a phone
// (ticket #222; spec #214 decisions 7 and 9, *Link day, in detail*; ADR-0031).
//
// WHY A CODE AT ALL. A QR requires two devices, because a phone cannot scan a
// code on its own screen — and ADR-0031 says what that silently assumes: "a
// laptop the rep may not have". So link day on a phone is eight characters the
// rep types into WhatsApp › Dispositivos vinculados, and the plane is what
// generates them.
//
// THE WINDOW IS ~160 SECONDS AND IT IS THE REP'S, NOT THE PLANE'S (ADR-0031;
// whatsmeow's own PairPhone comment says the same in library terms: "QR codes
// are always generated and the login websocket is closed after the QR codes
// run out, which means there's a 160-second time limit… generate the pairing
// code immediately after connecting to have the maximum time"). So the code is
// asked for right after connect, and the row that carries it is written before
// anything else happens.
//
// THE ROW IS THE `qr` ROW'S SHAPE. A `pairing_code` rail status row carries
// the code in `detail`, exactly as a `qr` row carries the QR payload: both are
// transient link credentials the plane itself generated, so neither is rep
// content under ADR-0008's scope (…20260827100007 argues that in full) and
// neither may be read by anything but the plane (…20260907100040's
// column-level grant, which withholds `detail` for precisely this reason).
//
// A CODE AND A QR ARE TWO DOORS TO ONE LINK SESSION, and rep-web offers
// whichever the viewport recommends. The ask is what opens a session when none
// stands (`plane/linksession` argues it, ticket #403): a session the library
// closed on its own clock, or a device WhatsApp logged out while the plane
// ran, leaves a plane waiting to be asked rather than one that needs a
// restart. Neither door decides what the rep's Dispositivos vinculados screen
// calls this companion — that is what the rep types into WhatsApp's own naming
// prompt (boundary #225, F15).
package pairing

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/bounded"
	"github.com/Dito-Core/dito/plane/planereq"
	"github.com/Dito-Core/dito/plane/railstatus"
)

// PhonePairer is the ONE library call this package makes: whatsmeow asks the
// server for a pairing code for a phone number and returns the eight
// characters the rep types. *whatsmeow.Client is the sole production
// implementation; the test records what it was handed and returns a
// constructed code.
//
// IT IS NOT A SEND, and the invariant scan is what says so structurally: the
// scan's selector list is the rail's MESSAGE-egress surface (SendMessage,
// SendPeerMessage, RevokeMessage, …) and `PairPhone` is not on it and is not
// one — it puts no stanza in any chat, reaches no counterparty, and speaks to
// the server about a link rather than to anybody about anything (ADR-0006).
type PhonePairer interface {
	PairPhone(ctx context.Context, phone string, showPushNotification bool, clientType whatsmeow.PairClientType, clientDisplayName string) (string, error)
}

// Recorder writes one rail status row — *railstatus.Store in the binary, the
// same one the QR path and every connection transition write through
// (ADR-0005 job 3).
type Recorder interface {
	Record(ctx context.Context, e railstatus.Event) error
}

// SelfSource is the live whatsmeow session identity — rail.Rail in the binary
// (ADR-0006: never a table or caller value). Here it answers one question:
// whether a session exists at all. `SelfJID` reads through to the device store
// and is not derivable before the device links, so its `ok` IS "this plane
// already holds a session" — which is why this reuses the sole-source doctrine
// rather than adding a second way to ask.
type SelfSource interface {
	SelfJID() (types.JID, bool)
}

// LinkSession opens a link session when none stands and says when it is
// ready for a code — *linksession.Session in the binary. PairPhone means
// something only inside a session, so the ask waits for one first.
type LinkSession interface {
	Ready(ctx context.Context) error
	// WhileStanding runs record only while the session still stands, so a
	// code is never written for a session that has already ended.
	WhileStanding(record func() error) error
}

// showPushNotification asks the SERVER to nudge the rep's phone about the
// pairing attempt.
//
// FALSE, DELIBERATELY. The rep is holding the phone: they opened the dashboard
// on it, read a code, and are typing it into WhatsApp — so a push about the
// thing they are doing is noise, and it arrives from WhatsApp rather than from
// Dito, which is the one voice link day must not confuse (ADR-0031: every
// notification comes from the dashboard).
const showPushNotification = false

// clientType is what this companion tells the server it IS, and it is not a
// browser.
//
// `companion_platform_id` IS WHERE IT LANDS (PairPhone's own hello node), and
// whatsmeow says the value does not matter — "must be one of the PairClient*
// constants, but which one doesn't matter". Of the twelve it offers, eleven
// name a browser, a desktop shell or a phone OS; `PairClientOtherWebClient`
// is the one that names none of those, and this plane is none of those: it is
// a service holding a linked device, with no window and no user agent. Saying
// «Chrome» would be a claim about software that is not running.
const clientType = whatsmeow.PairClientOtherWebClient

// clientDisplayName is what the pairing hello states about this companion, and
// it is a value out of the SERVER'S own documented vocabulary (ticket #245 F3;
// boundary #225).
//
// THE MEMBERSHIP IS ENFORCED AND NOT ONLY THE SHAPE, which is what makes this
// a value rather than a name. whatsmeow states the display verbatim in the
// hello and checks nothing itself (`pair-code.go`'s `companion_platform_display`
// node); its comment says the display "must be formatted as Browser (OS), and
// only common browsers/OSes are allowed (the server will validate it and return
// 400 if it's wrong)", and the rig measured which half of that bites: a display
// naming the product comes back refused on every ask, whatever follows it,
// because `Dito` is on no list of browsers (boundary #225, F3). A 400 on the
// hello is the rep's first attempt at link day failing, so the value comes out
// of the documented vocabulary and the test pins the shape beside it.
//
// AND THE REP LOSES NO NAME BY IT. What their Dispositivos vinculados screen
// calls this device is what THEY type into WhatsApp's own naming prompt, so no
// field in this hello decides it (boundary #225, F15; `plane/companion` holds
// the whole of that reading). The device properties still advertise the bare
// `companion.Name`, which is a different field with no format and no
// validator.
const clientDisplayName = "Chrome (Linux)"

// pairTimeout bounds THE hello. It talks to the server and waits for a
// reference, so it can hang like any request — and it sits inside a window
// that is 160 seconds wide and belongs to the rep, so a call that wedges must
// give the window back rather than consume it.
//
// Twenty seconds is the plane's rail-write budget doubled once (`ingest`'s ten,
// `rail`'s five), and it bounds the whole ceremony because there is one hello:
// a display the server refuses is refused again (`clientDisplayName` argues
// why), so at most twenty of the rep's hundred and sixty seconds are spent
// before the plane says so.
const pairTimeout = 20 * time.Second

// Config wires a Pairing.
type Config struct {
	Rail     PhonePairer
	Recorder Recorder
	Self     SelfSource
	Link     LinkSession
	// Wait overrides pairTimeout; zero takes the argued default.
	Wait time.Duration
}

// Pairing serves pairing-code requests. It is a planereq.Handler.
type Pairing struct {
	cfg Config
}

// New builds a Pairing.
func New(cfg Config) *Pairing { return &Pairing{cfg: cfg} }

func (p *Pairing) wait() time.Duration {
	if p.cfg.Wait > 0 {
		return p.cfg.Wait
	}
	return pairTimeout
}

// ask is the hello, under a bound this process enforces. Every parameter is
// the ceremony's own constant but the number, so there is nothing here for a
// call site to vary.
func (p *Pairing) ask(ctx context.Context, phone string) (string, error) {
	return bounded.Call(ctx, p.wait(), "the rail's pairing-code hello",
		func(pairCtx context.Context) (string, error) {
			return p.cfg.Rail.PairPhone(pairCtx, phone, showPushNotification, clientType, clientDisplayName)
		})
}

// Serve generates the code and writes it as a rail status row.
//
// THE ROW IS WRITTEN BEFORE THE REQUEST IS SERVED, and that order is the same
// one the QR path holds ("persist-first: a status — the scannable QR included
// — is surfaced only once its seam row exists", main.go's recorder): the row
// IS the surface. rep-web reads the rail's own rows, so a code that was
// generated and not recorded is a code no page can show, inside a window that
// does not come back.
//
// A PLANE THAT IS ALREADY LINKED REFUSES BY NAME. Pairing a plane that holds
// a session would either fail obscurely or replace a working link, and
// `already_linked` says which. A plane WITHOUT one is in a link session or is
// waiting to be asked into one, and the ask opens it.
func (p *Pairing) Serve(ctx context.Context, req planereq.Request) (planereq.Result, error) {
	if req.Phone == "" {
		// The store's own CHECK pairs a phone with this kind and refuses the
		// row without one, so the only way here is a row written past it. The
		// VALUE is never carried into an error either way: a seat's number is
		// the rep's own (ADR-0025).
		return planereq.Result{}, planereq.Refuse(planereq.ReasonMalformedParameter)
	}
	if _, linked := p.cfg.Self.SelfJID(); linked {
		return planereq.Result{}, planereq.Refuse(planereq.ReasonAlreadyLinked)
	}
	if err := p.cfg.Link.Ready(ctx); err != nil {
		return planereq.Result{}, fmt.Errorf("no link session to pair into: %w", err)
	}
	// THE CEREMONY IS BOUND BY THIS PROCESS, not by the library's willingness
	// to observe a context (ticket #222, Codex r3). `PairPhone` sends an IQ,
	// and the send takes the noise socket's write lock before it checks
	// cancellation — so on a half-open connection a context alone leaves this
	// request taken with no outcome and every later request waiting behind it
	// for the life of the process.
	code, err := p.ask(ctx, req.Phone)
	if errors.Is(err, bounded.ErrDidNotAnswer) {
		// NOT ASKED AGAIN, and that is the whole point of telling the two
		// failures apart (`bounded` argues it): a ceremony abandoned at its
		// bound MAY have reached the server, so a second hello could mint a
		// second code — two eight-character strings for one 160-second window,
		// of which the rep would be shown whichever landed in the row and
		// might type the other.
		return planereq.Result{}, fmt.Errorf("the pairing ceremony was abandoned: %w", err)
	}
	if err != nil {
		// The library's own reason is not carried: it reports pairing work by
		// the NUMBER it was pairing, and the number is the rep's own — the
		// same withholding `historyspike.Request` makes for the same reason
		// (ADR-0025).
		return planereq.Result{}, errors.New("the rail refused to generate a pairing code (its own reason is withheld: it names the seat's number)")
	}
	if code == "" {
		return planereq.Result{}, errors.New("the rail returned an empty pairing code — there is nothing for the rep to type")
	}
	// The instant is the plane's own: a credential's row is stamped when the
	// credential came into being, which is when the rep's 160 seconds started.
	err = p.cfg.Link.WhileStanding(func() error {
		return p.cfg.Recorder.Record(ctx, railstatus.Event{
			Status:     railstatus.StatusPairingCode,
			Detail:     code,
			OccurredAt: time.Now().UTC(),
		})
	})
	if err != nil {
		return planereq.Result{}, fmt.Errorf("recording the pairing code as a rail status row: %w", err)
	}
	return planereq.Result{}, nil
}
