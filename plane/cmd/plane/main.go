// Command plane runs the Dito connection plane (ADR-0005; ticket #21): it
// embeds whatsmeow, links via QR, resumes a persisted session across
// restarts, reconnects across socket drops, and records every rail
// transition as rail_status events on the Postgres seam. Zero business
// logic — config reads and seam writes only.
//
// Config (environment):
//
//	DITO_DATABASE_URL  Postgres DSN (default: the local dev seam)
//	DITO_TWIN_ID       uuid of the twin the linked number belongs to (required)
//	DITO_COMPANY_ID    uuid stamped on captured wa_events rows (required once provisioned)
//	DITO_SEAT_ID       uuid stamped on captured wa_events rows (required once provisioned)
//
// Plus the standard AWS environment for KMS (ADR-0008); the region falls
// back to us-east-1, the dev-account keys' home.
//
// Rig doctrine (#4): scan only with the RIG NUMBER's device — never a
// personal number.
//
// A FOURTH THING SITS BESIDE THE THREE JOBS (ticket #222): the request seam
// the twin runtime writes to (plane/planereq) — scope a chat in and fill its
// history, scope it out, or generate a pairing code. It is an internal sub-loop
// on the executor's own cadence, which is what ADR-0012 permits: same process,
// same twin, nothing a rep or an operator can name.
//
// One rig-only MODE lives here beside the plane (ticket #216):
// --history-spike-chat asks the linked phone whether it answers an
// on-demand history request for one chat and exits with what it learned. It
// wires none of the plane's three jobs — no rail status, no capture, no send
// execution — and plane/historyspike argues why it has to live in this
// binary at all. The operator stops the plane, runs the mode, restarts the
// plane.
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"

	"github.com/Dito-Core/dito/plane/bounded"
	"github.com/Dito-Core/dito/plane/companion"
	"github.com/Dito-Core/dito/plane/directory"
	"github.com/Dito-Core/dito/plane/executor"
	"github.com/Dito-Core/dito/plane/fill"
	"github.com/Dito-Core/dito/plane/historyspike"
	"github.com/Dito-Core/dito/plane/historywindow"
	"github.com/Dito-Core/dito/plane/ingest"
	"github.com/Dito-Core/dito/plane/lidmap"
	"github.com/Dito-Core/dito/plane/linksession"
	"github.com/Dito-Core/dito/plane/pairing"
	"github.com/Dito-Core/dito/plane/planereq"
	"github.com/Dito-Core/dito/plane/rail"
	"github.com/Dito-Core/dito/plane/railstatus"
	"github.com/Dito-Core/dito/plane/wastore"
)

const defaultDSN = "postgres://dito:dito@localhost:5433/dito_test?sslmode=disable"

// The rig-only spike's flags (ticket #216). Absent, the binary is the plane
// it has always been — an ordinary rig launch passes none of them.
var (
	historySpikeChat = flag.String("history-spike-chat", "",
		"RIG ONLY: ask the linked phone for older messages in this chat (JID) from the seam's newest message, print content-free counts, exit")
	historySpikeAnchor = flag.String("history-spike-anchor", string(historyspike.EdgeNewest),
		"RIG ONLY: which end of the chat's captured span to anchor on — `newest` (as runs 1-3 asked, and what the initial sync had already delivered) or `oldest` (messages this device never received)")
	historySpikeWait = flag.Duration("history-spike-wait", 90*time.Second,
		"RIG ONLY: how long --history-spike-chat waits for the phone's answer before reporting a timeout")
	advertiseOnDemandHistory = flag.Bool("advertise-on-demand-history", false,
		"RIG ONLY: advertise on-demand history readiness in the device properties — takes effect at the NEXT pairing, so it costs a QR re-scan")
	advertiseInitialSyncCap = flag.Uint("advertise-initial-sync-cap", 0,
		"RIG ONLY: advertise a cap of `n` messages per chat for the INITIAL history sync (0 advertises nothing) — takes effect at the NEXT pairing, and is the other half of the on-demand question (#214 decision 7(b))")
	historySpikeAddress = flag.String("history-spike-address", string(historyspike.AddressPN),
		"RIG ONLY: which identity the request names the chat by — `pn` (the seam's own, as runs 1-3 asked) or `lid` (the counterparty's hidden-user id, mapped through the plane's own store)")
	historySpikeAccountLID = flag.Bool("history-spike-account-lid", false,
		"RIG ONLY: state the account's own LID in the request's `accountLid` field, which whatsmeow leaves unset — the other candidate for run 3's silence")
	advertiseRecentSyncDays = flag.Uint("advertise-recent-sync-days", 0,
		"RIG ONLY: advertise a window of `n` days per chat for the pairing history push (0 advertises nothing) — takes effect at the NEXT pairing, and is the other way to make that push smaller after the per-chat cap was ignored (#216)")
	historySpikeLinger = flag.Duration("history-spike-linger", 0,
		"RIG ONLY: after the finding, keep the socket open this long and report every history event that still arrives (0 exits as before) — an answer whose data chunk lands a minute after its metadata chunk was being thrown away")
	historySpikeTimestampUnit = flag.String("history-spike-timestamp-unit", string(historyspike.UnitSeconds),
		"RIG ONLY: the unit the request states the anchor's instant in — `seconds` (what the library sends, and every arm so far) or `millis` (what the protocol field's name says)")
	historySpikeInlineResponse = flag.Bool("history-spike-inline-response", false,
		"RIG ONLY: state in the request that this companion can take the answer inline (`supportInlineResponse`, the one request field the official web client sets and no library does)")
	historySpikeVerbose = flag.Bool("history-spike-verbose", false,
		"RIG ONLY, DEBUG LANE: trace every history sync and peer response the spike inspects, and let whatsmeow log at DEBUG — the library's DEBUG output names other chats, so this is for the operator's terminal, never a ticket comment")
)

// spikeStepTimeout bounds each step of the spike that must not hang before
// the wait even begins — the seam read, the rail coming up, the peer send —
// mirroring the plane's per-step budget doctrine (ingest's eventTimeout,
// rail's recordTimeout). An operator holding a rig session open is owed a
// verdict, and a command wedged before it has asked anything gives none.
const spikeStepTimeout = 30 * time.Second

// loggingRecorder persists each rail_status event, then tees it to the
// operator's terminal. Persist-first: a status — the scannable QR included —
// is surfaced only once its seam row exists (AC 1: surfaced via
// rail_status). Fail-stop on a write failure: a plane that cannot record
// rail truth must not keep running as if it could; the persisted whatsmeow
// session survives, so a restart resumes without re-scan.
type loggingRecorder struct {
	store *railstatus.Store
}

func (l *loggingRecorder) Record(ctx context.Context, e railstatus.Event) error {
	if err := l.store.Record(ctx, e); err != nil {
		log.Fatalf("FATAL: recording rail_status %s on the seam: %v", e.Status, err)
	}
	if e.Status == railstatus.StatusQR {
		log.Printf("rail_status: qr (scan with the RIG NUMBER's device — never a personal number)")
		qrterminal.GenerateHalfBlock(e.Detail, qrterminal.L, os.Stdout)
	} else {
		log.Printf("rail_status: %s", e.Status)
	}
	return nil
}

func run() error {
	flag.Parse()
	ctx := context.Background()

	dsn := os.Getenv("DITO_DATABASE_URL")
	if dsn == "" {
		dsn = defaultDSN
	}
	twinID := os.Getenv("DITO_TWIN_ID")
	if _, err := uuid.Parse(twinID); err != nil {
		return fmt.Errorf("DITO_TWIN_ID must be the twin's uuid: %w", err)
	}

	// THE SHARED STARTUP CARRIES THE SPIKE'S BUDGET when the mode was asked
	// for (Codex r3): the plane is a service and waits for its database, but a
	// rig command is a person at a terminal, and a Postgres that accepts TCP
	// and then stalls — or a device query behind a lock — would hang it before
	// it could reach a timeout of its own. Nothing holds this context past
	// these three calls (wastore's container keeps the pool, not the context),
	// so the budget expiring cannot disturb a run already under way.
	startupCtx := ctx
	if flagSupplied("history-spike-chat") {
		var cancelStartup context.CancelFunc
		startupCtx, cancelStartup = context.WithTimeout(ctx, spikeStepTimeout)
		defer cancelStartup()
	}

	seamDB, err := sql.Open("pgx", dsn)
	if err != nil {
		return fmt.Errorf("opening seam connection: %w", err)
	}
	defer seamDB.Close()
	if err := seamDB.PingContext(startupCtx); err != nil {
		return fmt.Errorf("seam Postgres unreachable (run `pnpm db:up`?): %w", err)
	}

	container, err := wastore.Open(startupCtx, dsn)
	if err != nil {
		return err
	}
	defer container.Close()
	// Explicit device selection, never "whichever row comes first": slice 1
	// runs exactly one rig number, so a second stored device means the
	// store is not what this plane believes it is — refuse rather than
	// resume an arbitrary session under the configured twin. The durable
	// twin-to-device binding row is #20's per-twin state home.
	devices, err := container.GetAllDevices(startupCtx)
	if err != nil {
		return fmt.Errorf("loading whatsmeow devices: %w", err)
	}
	var device *store.Device
	switch len(devices) {
	case 0:
		device = container.NewDevice()
	case 1:
		device = devices[0]
	default:
		return fmt.Errorf("whatsmeow store holds %d devices, want at most 1 — refusing to guess which session belongs to twin %s", len(devices), twinID)
	}

	// What this device calls itself on the rep's own phone (companion.Advertise
	// argues the whole of it, ticket #222).
	companion.Advertise()

	// The pairing payload is composed from store.DeviceProps inside the link
	// flow, so the capability switch is thrown before the client exists: it
	// changes the NEXT pairing and nothing about a live session (#216).
	if *advertiseOnDemandHistory {
		historyspike.AdvertiseOnDemandHistory()
		log.Print("device properties: on-demand history readiness advertised — takes effect at the next pairing only (#216)")
	}
	// The VALIDATED value is what gets advertised and what gets logged, and
	// they are the same number by construction (Codex r1).
	syncCap, err := historyspike.ParseInitialSyncCap(uint64(*advertiseInitialSyncCap))
	if err != nil {
		return fmt.Errorf("--advertise-initial-sync-cap: %w", err)
	}
	if syncCap > 0 {
		historyspike.AdvertiseInitialSyncCap(syncCap)
		log.Printf("device properties: initial history sync capped at %d message(s) per chat — takes effect at the next pairing only (#216)", syncCap)
	}
	recentDays := uint32(0)
	if recentDays, err = historyspike.ParseRecentSyncDays(uint64(*advertiseRecentSyncDays)); err != nil {
		return fmt.Errorf("--advertise-recent-sync-days: %w", err)
	}
	if recentDays > 0 {
		historyspike.AdvertiseRecentSyncDays(recentDays)
		log.Printf("device properties: pairing history push limited to the last %d day(s) per chat — takes effect at the next pairing only (#216)", recentDays)
	}

	// The rig-only spike returns here, BEFORE the plane's client, the rail,
	// the capture guard and the executor exist (#216): the mode cannot write a
	// seam row or capture a delivery because none of the plane's three jobs
	// exists in its process, and it can never run beside the ordinary event
	// loop. Its client is its own, and silent unless the operator asks
	// otherwise — see runHistorySpike.
	//
	// ASKED FOR, NOT NON-EMPTY (Codex r2). `--history-spike-chat="$CHAT"` with
	// the variable unset asks for the mode with an empty chat, and reading the
	// value alone would fall through to the ORDINARY plane: capture armed, the
	// executor consuming queued sends, on a rig the operator believes is
	// running a read-only probe. Whether the flag was SUPPLIED is the
	// question, and an empty value is then refused by ParseChat.
	if flagSupplied("history-spike-chat") {
		return runHistorySpike(ctx, device, seamDB, twinID)
	}
	if *historySpikeVerbose {
		// It says nothing about an ordinary plane run, and a flag that is
		// quietly ignored is a rig session spent believing it was on.
		return errors.New("--history-spike-verbose belongs to the history spike — pass --history-spike-chat too, or drop it")
	}

	// The chat directory and the twin's history window (ticket #222): the guard
	// records every conversation it sees in the first, in scope or not, and
	// bounds an on-demand page by the second. Both are ordinary seam stores on
	// the same connection and neither holds a key, which is why they are built
	// outside the custody branch below — the pairing code needs no DEK, and
	// link day is exactly the moment a twin may have no capture yet.
	deps := railDeps{
		db:       seamDB,
		twinID:   twinID,
		recorder: &loggingRecorder{store: railstatus.NewStore(seamDB, twinID)},
		chats:    directory.New(seamDB, twinID),
		window:   historywindow.New(seamDB, twinID),
	}
	// One twin identity binds the seam row, the KMS alias, and the
	// encryption context — the binary offers no lever to pair a twin with
	// another twin's key (ADR-0008; Codex round 2).
	kmsClient, err := twinKMS(ctx)
	if err != nil {
		return err
	}
	sealer, err := ingest.LoadSealer(ctx, seamDB, kmsClient, twinID, twinID)
	switch {
	case errors.Is(err, ingest.ErrUnprovisionedTwin):
		log.Printf("WARNING: capture disabled — %v. In-scope inbound will NOT be captured until the plane restarts with the twin provisioned.", err)
	case err != nil:
		// A provisioned-but-broken crypto path must die observably, never
		// run as a plane that silently drops in-scope content (ADR-0008).
		return fmt.Errorf("loading the twin's DEK into plane custody: %w", err)
	default:
		companyID := os.Getenv("DITO_COMPANY_ID")
		seatID := os.Getenv("DITO_SEAT_ID")
		if _, err := uuid.Parse(companyID); err != nil {
			return fmt.Errorf("DITO_COMPANY_ID must be the company's uuid once the twin is provisioned: %w", err)
		}
		if _, err := uuid.Parse(seatID); err != nil {
			return fmt.Errorf("DITO_SEAT_ID must be the seat's uuid once the twin is provisioned: %w", err)
		}
		deps.sealer = sealer
		deps.stamp = ingest.Stamp{CompanyID: companyID, SeatID: seatID, TwinID: twinID}
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	// ONE CLIENT PER DEVICE, AND A FRESH ONE AFTER A LOG-OUT (ticket #403).
	// whatsmeow deletes a logged-out device's store and binds each client to
	// one device for its whole life — its app-state processor is built over
	// that device's store — so the session WhatsApp severed cannot be linked
	// again through the client that held it. `runRail` ends when that happens
	// and this loop starts the next client on a fresh device, which then
	// waits for the rep to ask: only the plane's own start opens a link
	// session unasked.
	openAtStart := true
	for {
		ended, err := runRail(ctx, deps, device, openAtStart, stop)
		if err != nil || ended == stopped {
			return err
		}
		openAtStart = false
		if device, err = nextDevice(ctx, container, device, ended == loggedOut); err != nil {
			return err
		}
	}
}

// railDeps is what every client the plane runs shares: the seam, the twin, and
// — once the twin is provisioned — the DEK custody capture and sends need.
type railDeps struct {
	db       *sql.DB
	twinID   string
	recorder *loggingRecorder
	chats    *directory.Store
	window   *historywindow.Store
	// sealer is nil while the twin is unprovisioned: the plane then runs
	// link-only, loudly, so a silent capture gap is impossible.
	sealer *ingest.Sealer
	stamp  ingest.Stamp
}

// railEnd is how one client's run ended.
type railEnd int

const (
	// stopped — the process ends: a signal, or an error beside it.
	stopped railEnd = iota
	// loggedOut — WhatsApp severed the session; the next client needs a fresh
	// device.
	loggedOut
	// spoiled — a link-session dial failed; the next client keeps the device.
	spoiled
)

// runRail runs one whatsmeow client over one device: the rail, the capture
// guard, the executor and the request loop, wired to it, and says how it
// ended.
func runRail(ctx context.Context, d railDeps, device *store.Device, openAtStart bool, stop <-chan os.Signal) (railEnd, error) {
	client := whatsmeow.NewClient(device, waLog.Stdout("whatsmeow", "INFO", true))

	// An always-on plane must survive starting while the network is down:
	// retry the initial dial instead of exiting (whatsmeow leaves this off
	// by default). The spike deliberately does without it — a probe that
	// cannot dial has learned nothing and must say so.
	client.InitialAutoReconnect = true
	// ...AND THE INITIAL ADDRESS BOOK HAS TO REACH THE HANDLER (ticket #222,
	// Codex r1). whatsmeow suppresses app-state events on a FULL sync unless
	// this is set (appstate.go), and a full sync is what a fresh pairing does —
	// so the chat directory would take later contact EDITS and miss the
	// snapshot, leaving every chat the rep has not messaged since pairing
	// without a name on the scoping page. The plane subscribes to two of those
	// events and ignores the rest; each writes one content-free directory
	// upsert.
	client.EmitAppStateEventsOnFullSync = true
	link := rail.New(d.recorder, device)
	client.AddEventHandler(link.HandleEvent)

	// ...and the capture guard's own rule, reachable without a DEK because the
	// guard's decision is a config read (ingest.ScopeReader argues why the fill
	// is its fourth caller).
	scope := ingest.NewScopeReader(d.db, d.twinID, link)

	// The capture guard + encrypted ingest (ticket #22, ADR-0005 job 1),
	// wired beside the rail's handler, with the DEK out of twin_keys via real
	// KMS (ADR-0008).
	var exec *executor.Executor
	if d.sealer != nil {
		ing := ingest.New(ingest.Config{
			DB:        d.db,
			Sealer:    d.sealer,
			Stamp:     d.stamp,
			Self:      link,
			Directory: d.chats,
			// The library's own identity map, the second source the guard
			// resolves a LID-keyed history conversation through. It reaches no
			// network: the PHONE fills it inside its own history syncs.
			//
			// READ THROUGH THE DEVICE AT EVERY LOOKUP rather than copied here
			// (Codex r1): `Container.NewDevice` returns a device whose `LIDs` is
			// nil and only `PutDevice` fills it — which happens DURING pairing —
			// so a value copied at wiring time is nil for the whole of the
			// session a fresh link establishes, and the guard would silently
			// lose its second source on exactly the day the directory has
			// nothing in it yet.
			LIDs:   liveLIDs{device: device},
			Window: d.window,
			OnError: func(err error) {
				// Fail-stop, mirroring the rail's seam-write doctrine: a
				// plane that cannot capture what the guard admits must not
				// keep consuming as if it could.
				log.Fatalf("FATAL: capture guard/ingest: %v", err)
			},
		})
		client.AddEventHandler(ing.HandleEvent)
		log.Print("capture guard armed: scope allowlist + self-chat, payloads DEK-encrypted in-plane; chat directory recording every conversation, content-free")

		// Send execution (ticket #25, ADR-0005 job 2): the sole caller of
		// the rail's send APIs, consuming send_commands for this twin.
		// system_send re-derives "self" from the live session on every
		// send (ADR-0006); content decrypts under the same DEK custody as
		// ingest. Pre-provisioning there is nothing to execute — commands
		// only exist once the twin-runtime runs.
		//
		// Capture is the SAME ingestor armed above (ticket #63): a delivered
		// customer_send is recorded into twin memory through the capture
		// guard's own door, so what the rep said through the twin is as
		// visible to it as what the customer said. WhatsApp never echoes the
		// sending device's own messages back, so without this the twin is
		// amnesiac about its own words.
		exec = executor.New(executor.Config{
			DB:      d.db,
			Sender:  client,
			Self:    link,
			Opener:  d.sealer,
			Capture: ing,
			TwinID:  d.twinID,
		})
	}

	// relink is how this client says its session is over for good: WhatsApp
	// logged the device out, or the link session could not dial. Buffered and
	// never blocking, because both are said from the library's own goroutines.
	//
	// A LOG-OUT OUTRANKS A SPOILED DIAL when both are said, because it is the
	// one that spends the device; the flag is set before the signal is sent.
	relink := make(chan string, 1)
	var wasLoggedOut atomic.Bool
	severed := func(reason string) {
		select {
		case relink <- reason:
		default:
		}
	}
	// THE LOOPS AND THE LINK SESSIONS LIVE AS LONG AS THIS CLIENT, and end
	// together when it is replaced.
	loopCtx, cancelLoops := context.WithCancel(ctx)
	defer cancelLoops()
	session := linksession.New(loopCtx, linksession.Config{
		Library: client,
		Rail:    link,
		Logf:    log.Printf,
		Spoiled: severed,
	})

	// The plane's request loop (ticket #222): scope in, scope out, and the
	// pairing-code ask.
	//
	// OUTSIDE THE CUSTODY BRANCH, and that is what makes link day work: a
	// pairing code is asked for by a plane that holds NO SESSION, and a seat
	// whose twin the runtime has not provisioned yet holds no DEK either — so a
	// loop built only where capture is armed could not serve the one request
	// that comes first. None of the three handlers opens a payload.
	//
	// THE PAGER IS REGISTERED AFTER THE CAPTURE GUARD, and the order is
	// load-bearing rather than incidental: whatsmeow dispatches one event to
	// its handlers in registration order on one goroutine, so a page's rows
	// have landed on the seam by the time the fill is told the page arrived.
	// The fill records progress about history that is already there rather than
	// about history that is on its way.
	pager := fill.NewPager()
	client.AddEventHandler(pager.HandleEvent)
	requests := planereq.New(planereq.Config{
		DB:     d.db,
		TwinID: d.twinID,
		Handlers: map[planereq.Kind]planereq.Handler{
			planereq.KindScopeIn: fill.New(fill.Config{
				Rail:      client,
				Directory: d.chats,
				Window:    d.window,
				Self:      link,
				LIDs:      liveLIDs{device: device},
				Scope:     scope,
				Pager:     pager,
			}),
			planereq.KindScopeOut: fill.ScopeOut{},
			planereq.KindPairingCode: pairing.New(pairing.Config{
				Rail:     client,
				Recorder: railstatus.NewStore(d.db, d.twinID),
				Self:     link,
				Link:     session,
			}),
		},
		// LOUD, NOT FATAL. A request the plane cannot serve is settled
		// `failed` and the loop carries on: a bad ask about the rep's own
		// history must never take capture, the rail and every other request
		// down with it (planereq's package header argues it).
		OnError: func(err error) { log.Printf("plane request: %v", err) },
		// THE FILL'S MARKER IS A PROJECTION OF THE REQUEST ROW, re-derived once
		// per pass (ticket #245 F17). A fill stamps its own end as it goes, but
		// that write can fail and its process can stop between the stamp and
		// the settle — and a row left saying «a fill is running» is a card that
		// never retires. `ProjectStops` argues the statement.
		OnSwept: d.chats.ProjectStops,
	})

	// A temporary ban disables whatsmeow's auto-reconnect: fail-stop so the
	// outage is a dead process, never a silently waiting one. The rail has
	// already recorded the enforcement signal as logged_out. A log-out is the
	// other severing, and it is the rep's to repair from the dashboard: the
	// rail has recorded it, and the next client waits for their ask.
	banned := make(chan string, 1)
	client.AddEventHandler(func(evt any) {
		switch e := evt.(type) {
		case *events.TemporaryBan:
			select {
			case banned <- e.String():
			default:
			}
		case *events.LoggedOut:
			wasLoggedOut.Store(true)
			severed("logged out (" + e.Reason.String() + ")")
		}
	})

	if device.ID == nil {
		if openAtStart {
			log.Print("no persisted session — starting a link session (QR follows)")
			if err := session.Open(loopCtx); err != nil {
				return stopped, fmt.Errorf("starting link session: %w", err)
			}
		} else {
			log.Print("no session — a pairing code ask from the dashboard opens the next link session")
		}
	} else {
		log.Printf("persisted session found for %s — resuming without re-scan", device.ID)
		if err := client.Connect(); err != nil {
			return stopped, fmt.Errorf("connecting: %w", err)
		}
		if jid, ok := link.SelfJID(); ok {
			log.Printf("self (derived from live session identity): %s", jid)
		}
	}

	// The executor loop starts with the client: pending commands stay
	// pending (loudly) until the session identity is live, and any real
	// executor error fail-stops the plane — a command it cannot execute
	// correctly is a broken seam, never something to spin past.
	loopErr := make(chan error, 2)
	var loops sync.WaitGroup
	if exec != nil {
		loops.Add(1)
		go func() {
			defer loops.Done()
			if err := exec.Run(loopCtx, time.Second); err != nil {
				loopErr <- err
			}
		}()
		log.Print("send executor armed: sole caller of the rail's send APIs (ADR-0006)")
	}
	// ...and the request loop beside it, on the same cadence and the same
	// context (ticket #222). It runs WHETHER OR NOT A SESSION STANDS, because
	// the pairing-code ask is what opens one (ticket #403); a scope-in on an
	// unlinked plane refuses by name.
	//
	// AN INTERNAL SUB-LOOP, WHICH IS WHAT ADR-0012 PERMITS: same process, same
	// twin, nothing a rep or an operator can name or schedule. It returns only
	// on an infrastructure failure — a table it cannot read, a settle it cannot
	// write — and that is fatal for the executor's reason too, so it shares the
	// same channel.
	loops.Add(1)
	go func() {
		defer loops.Done()
		if err := requests.Run(loopCtx, time.Second); err != nil {
			loopErr <- err
		}
	}()
	log.Print("plane request loop armed: scope in, scope out, pairing code (ticket #222)")

	select {
	case <-stop:
		log.Print("shutting down (session persists; restart resumes without re-scan)")
		// A deliberate teardown is still a socket drop on the seam — the
		// restart then reads linked → dropped → linked, not a duplicate
		// linked.
		cancelLoops()
		link.HandleShutdown()
		client.Disconnect()
		return stopped, nil
	case err := <-loopErr:
		link.HandleShutdown()
		client.Disconnect()
		return stopped, fmt.Errorf("send executor: %w", err)
	case reason := <-banned:
		client.Disconnect()
		return stopped, fmt.Errorf("enforcement signal: %s — recorded as logged_out on the seam; per rig doctrine (#4) record a steering finding before relinking", reason)
	case reason := <-relink:
		// THE LOOPS END BEFORE THE NEXT CLIENT STARTS, so one twin never has
		// two request loops or two executors: a request mid-serve finishes and
		// settles on its own budget, and the next client's loop takes the rest.
		log.Printf("rail: %s — this client is done; the next one waits for a pairing code ask", reason)
		cancelLoops()
		loops.Wait()
		client.Disconnect()
		if wasLoggedOut.Load() {
			return loggedOut, nil
		}
		return spoiled, nil
	}
}

// nextDevice is the device the next client runs on after one was severed.
//
// THE SPENT DEVICE OBJECT IS NEVER TRUSTED OR TOUCHED HERE. After a log-out
// whatsmeow deletes it on its own goroutine, and after a pairing that failed
// part way it carries an identity the store never saved — so the next device
// comes from rows read fresh, which is idempotent against the library's own
// delete landing first.
//
// AFTER A LOG-OUT EVERY STORED DEVICE IS SPENT: one plane runs one device, and
// WhatsApp has severed it. A spent row left in the store would make the next
// start find two devices and refuse to guess, so they are cleared.
//
// OTHERWISE THE STORE IS THE TRUTH: the one device it holds, or a new one —
// the spent object only when it never took an identity, so its keys are kept.
func nextDevice(ctx context.Context, container *sqlstore.Container, spent *store.Device, loggedOut bool) (*store.Device, error) {
	stored, err := container.GetAllDevices(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading the store for the next client: %w", err)
	}
	if loggedOut {
		for _, device := range stored {
			if err := container.DeleteDevice(ctx, device); err != nil {
				return nil, fmt.Errorf("deleting the logged-out device's session from the store: %w", err)
			}
		}
		return container.NewDevice(), nil
	}
	switch len(stored) {
	case 0:
		if spent.ID == nil {
			return spent, nil
		}
		return container.NewDevice(), nil
	case 1:
		return stored[0], nil
	default:
		return nil, fmt.Errorf("whatsmeow store holds %d devices, want at most 1 — refusing to guess which session to resume", len(stored))
	}
}

// liveLIDs reads whatsmeow's phone-number-to-LID map OFF THE DEVICE at every
// lookup, which is the only way to hold it across a pairing (Codex r1 on
// #222): `Container.NewDevice` leaves `Device.LIDs` nil and `PutDevice` fills
// it in the middle of the link handshake, so anything that copied the
// interface value at wiring time would hold nil for the life of the session
// that link established.
//
// A nil map is SILENCE rather than a failure: before pairing there is nothing
// to know, and both callers treat "neither source knows" as a fact rather than
// an error (the guard keeps the LID as the identity, the fill refuses by name).
type liveLIDs struct{ device *store.Device }

func (l liveLIDs) GetPNForLID(ctx context.Context, lid types.JID) (types.JID, error) {
	if l.device.LIDs == nil {
		return types.JID{}, nil
	}
	return l.device.LIDs.GetPNForLID(ctx, lid)
}

func (l liveLIDs) GetLIDForPN(ctx context.Context, pn types.JID) (types.JID, error) {
	if l.device.LIDs == nil {
		return types.JID{}, nil
	}
	return l.device.LIDs.GetLIDForPN(ctx, pn)
}

// twinKMS builds the KMS client the twin's DEK is unwrapped through
// (ADR-0008), defaulting the region to the dev account's home when the
// environment names none. The plane and the rig-only spike take the same
// custody the same way — the spike opens one captured payload to read its
// anchor, so it needs the DEK exactly as capture does.
func twinKMS(ctx context.Context) (*kms.Client, error) {
	var awsOpts []func(*awsconfig.LoadOptions) error
	if os.Getenv("AWS_REGION") == "" && os.Getenv("AWS_DEFAULT_REGION") == "" {
		awsOpts = append(awsOpts, awsconfig.WithRegion("us-east-1"))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsOpts...)
	if err != nil {
		return nil, fmt.Errorf("loading AWS config for KMS (ADR-0008): %w", err)
	}
	return kms.NewFromConfig(awsCfg), nil
}

// runHistorySpike wires the rig-only probe the historyspike package argues
// for, in the one order that works. The anchor is resolved BEFORE the socket
// opens, so a chat the seam holds nothing for costs the rig no connection at
// all; the watcher is wired BEFORE the request is sent, because the phone
// can answer inside the same second; the request's own id is handed to the
// watcher the moment the rail mints it, so a leftover refusal from an
// earlier run is not read as this one's; the wait is bounded; and the exit
// code is the finding — 0 for an answer, non-zero with the ending on the
// line for a refusal or a timeout.
//
// A chat the seam holds no message for is a fourth non-zero exit and says
// so in its own words: it is not a finding about the library path under
// test, and reporting it as a timeout would put a false one on the ticket.
//
// THE LIBRARY IS SILENT HERE, AND THAT IS THE OUTPUT CONTRACT (Codex r1).
// whatsmeow's own logger reports unrelated traffic by chat and sender —
// «Unavailable message %s from %s», decryption failures, receipts — so the
// plane's INFO logger on this socket would put foreign JIDs on the operator's
// terminal beside a finding that is content-free by construction (#216 AC 2).
// The mode's own lines are its whole output; the plane's ordinary run keeps
// the library's voice, and an operator who needs it runs the plane — or asks
// for it here with --history-spike-verbose, which says what it costs.
func runHistorySpike(ctx context.Context, device *store.Device, seamDB *sql.DB, twinID string) error {
	chat, err := historyspike.ParseChat(*historySpikeChat)
	if err != nil {
		return fmt.Errorf("--history-spike-chat: %w", err)
	}
	address, err := historyspike.ParseAddressing(*historySpikeAddress)
	if err != nil {
		return fmt.Errorf("--history-spike-address: %w", err)
	}
	edge, err := historyspike.ParseEdge(*historySpikeAnchor)
	if err != nil {
		return fmt.Errorf("--history-spike-anchor: %w", err)
	}
	unit, err := historyspike.ParseTimestampUnit(*historySpikeTimestampUnit)
	if err != nil {
		return fmt.Errorf("--history-spike-timestamp-unit: %w", err)
	}
	if device.ID == nil {
		return errors.New("no persisted session — the spike asks a phone that is already linked and never starts a link session; run the plane normally to link")
	}
	kmsClient, err := twinKMS(ctx)
	if err != nil {
		return err
	}
	custodyCtx, cancelCustody := context.WithTimeout(ctx, spikeStepTimeout)
	defer cancelCustody()
	// The anchor's payload is opened in plane custody, exactly as capture
	// seals one (ADR-0008): an unprovisioned twin is a hard stop here rather
	// than the plane's link-only warning, because without the DEK there is no
	// anchor to ask with.
	sealer, err := ingest.LoadSealer(custodyCtx, seamDB, kmsClient, twinID, twinID)
	if err != nil {
		return fmt.Errorf("loading the twin's DEK into plane custody: %w", err)
	}
	anchor, err := historyspike.Seam{DB: seamDB, Opener: sealer, TwinID: twinID}.Anchor(custodyCtx, chat, edge)
	if err != nil {
		return err
	}
	log.Printf("history spike: anchor chat=%s end=%s from_me=%t at=%s (nothing is captured and nothing is written)",
		chat, edge, anchor.FromMe, anchor.At.Format(time.RFC3339))

	// THE VERBOSE LANE IS A DELIBERATE SUSPENSION OF THE OUTPUT CONTRACT
	// (historyspike.Trace argues why run 2 needs it). The trace itself stays
	// content-free; whatsmeow's DEBUG log is what names other chats, so the
	// flag warns, and it is off by default.
	logger := waLog.Noop
	var trace historyspike.Trace
	if *historySpikeVerbose {
		log.Print("history spike: VERBOSE — whatsmeow's DEBUG log names other chats and can carry message bytes; read it on this terminal, never paste it into a ticket (#216)")
		logger = waLog.Stdout("whatsmeow", "DEBUG", true)
		trace = func(line string) { log.Print(line) }
	}

	client := whatsmeow.NewClient(device, logger)
	// NO RECONNECT ON THIS SOCKET (Codex r2). whatsmeow reconnects by default,
	// and a reconnect dials while holding the socket lock — so a stalled
	// redial during the wait would block the deferred Disconnect below and the
	// mode would never print its finding. A one-shot probe whose socket drops
	// has learned what it can: the wait times out, which is an honest ending.
	client.EnableAutoReconnect = false

	// WHICH IDENTITY THE REQUEST WILL NAME THE CHAT BY, resolved BEFORE the
	// socket opens: the map is the plane's own store, filled by the phone
	// itself at history sync, so the lookup is a database read and costs no
	// round trip — and the instrument needs both names of the chat before the
	// first event can arrive (#216). A chat the store knows no LID for is
	// refused here, without a connection, as the anchor's own absence is.
	//
	// ON ITS OWN GOROUTINE, under the step budget, for the dial's reason a
	// third time (Codex r1): whatsmeow's cached LID map takes a mutex and
	// falls through to Postgres on a miss, and neither the mutex nor a stalled
	// query honours a context — so a lookup that wedges here would end a rig
	// session with no finding at all, before any of the later budgets exist.
	addressed, err := resolved(ctx, func(lookupCtx context.Context) (types.JID, error) {
		return historyspike.AddressChat(lookupCtx, client.Store.LIDs, chat, address)
	})
	if err != nil {
		return err
	}

	// BOTH NAMES OF THE CHAT go to the instrument: the answer may be filed
	// under either, and matching only the PN one is what made every answer
	// read empty (#216).
	watcher := historyspike.NewTracingWatcher(chat, addressed, trace)
	client.AddEventHandler(watcher.HandleEvent)
	// THE LINGER LISTENS BESIDE THE WATCHER, from before the socket opens, so
	// a chunk that arrives while the finding is still settling is counted by
	// both — the watcher for the finding, the linger for the record of what
	// the phone actually sent (#216). Its own lines go out whenever the lane
	// is asked for, verbose or not: they ARE the measurement.
	linger := historyspike.NewLinger(chat, addressed, func(line string) { log.Print(line) })
	lingering := uint32(0)
	if *historySpikeLinger > 0 {
		lingering = client.AddEventHandler(linger.HandleEvent)
	}

	// THE DIAL RUNS ON ITS OWN GOROUTINE because Connect can block forever
	// (Codex r1): it dials on the library's background context with a
	// websocket client that sets no upgrade timeout, so a connection that
	// completes TLS and then stalls returns to nobody. Giving the step a
	// budget here is what keeps the whole mode bounded.
	//
	// AND THE STALL PATH DOES NOT DISCONNECT: whatsmeow holds its socket lock
	// for the length of the dial, so asking it to disconnect would block
	// behind the stall and the process would never exit. Returning takes the
	// dial down with the process.
	dialed := make(chan error, 1)
	go func() { dialed <- client.Connect() }()
	select {
	case err := <-dialed:
		if err != nil {
			return fmt.Errorf("connecting: %w", err)
		}
	case <-time.After(spikeStepTimeout):
		return fmt.Errorf("the dial stalled for %s — nothing was asked", spikeStepTimeout)
	}
	defer client.Disconnect()
	if !client.WaitForConnection(spikeStepTimeout) {
		return fmt.Errorf("the rail did not come up within %s — nothing was asked", spikeStepTimeout)
	}

	// The request as this arm sends it: the identity resolved above, the
	// anchor read off the seam, and the two request fields the arms vary.
	ask := historyspike.Ask{
		Chat:           chat,
		Addressed:      addressed,
		Anchor:         anchor,
		Unit:           unit,
		InlineResponse: *historySpikeInlineResponse,
	}
	if *historySpikeAccountLID {
		// The stored LID carries this device's number (pair.go saves it
		// device-qualified); the request's field wants the account's.
		if ask.AccountLID, err = historyspike.AccountLID(client.Store.GetLID()); err != nil {
			return fmt.Errorf("--history-spike-account-lid: %w", err)
		}
	}

	// From here an ON_DEMAND history or a refusal is this run's; before it,
	// anything that arrives was queued for an earlier one (Watcher says why).
	watcher.Asking()
	// AND THE SEND IS BOUND BY THIS PROCESS, for the dial's reason one layer
	// down: whatsmeow takes the socket's write lock before it looks at the
	// context, so a send can queue behind an automatic acknowledgement stalled
	// on a socket that stopped accepting bytes, and an expiring context does
	// not release it. `plane/bounded` holds the one implementation of that
	// bound — the fill's ask and the pairing hello run under it too.
	request, err := bounded.Call(ctx, spikeStepTimeout, "the rail's on-demand history request",
		func(sendCtx context.Context) (types.MessageID, error) {
			return historyspike.Request(sendCtx, client, ask)
		})
	if errors.Is(err, bounded.ErrDidNotAnswer) {
		// The reading the rig needs, and the one `bounded` cannot know: an
		// abandoned send may already have reached the server, so a run that
		// ends here has not established that the phone was never asked.
		return fmt.Errorf("%w — whether the request left the socket is unknown", err)
	}
	if err != nil {
		return err
	}
	watcher.Asked(request)
	// WHICH KNOBS WERE TURNED, never the identities they resolved to: the LID
	// of the chat and of the account are the two things this line must not
	// name, and which anchor and which addressing are the whole of what a
	// later reader needs to pair a transcript with one arm of the protocol
	// (#216).
	log.Printf("history spike: asked chat=%s anchor=%s address=%s account_lid=%s ts_unit=%s inline_response=%s count=%d waiting=%s",
		chat, edge, address, stated(!ask.AccountLID.IsEmpty()), unit, set(ask.InlineResponse),
		historyspike.MessagesPerRequest, *historySpikeWait)

	finding := watcher.Await(*historySpikeWait)
	log.Print(finding.Line())
	// THE FINDING IS PRINTED FIRST, THEN THE LANE STAYS OPEN. An answer that
	// arrives in two parts a minute apart is the reading every twelve-second
	// run left open, and the only way to see the second part is to still be
	// connected when it lands.
	if *historySpikeLinger > 0 {
		log.Printf("history spike: lingering %s (nothing is captured and nothing is written)", *historySpikeLinger)
		open := linger.Wait(*historySpikeLinger)
		// THE HANDLER GOES BEFORE THE COUNT IS STATED (Codex r1): whatsmeow
		// dispatches a downloaded history blob on its own goroutine, so a
		// chunk landing during shutdown could otherwise print after a count
		// that called itself final. Unregistering closes the door; Close
		// silences whatever was already through it.
		client.RemoveEventHandler(lingering)
		linger.Close()
		log.Print(linger.Done(open))
	}
	if finding.Ending == historyspike.Answered {
		return nil
	}
	// The ending is already on the terminal; what the error adds is the
	// non-zero exit and a reason named in one word.
	return fmt.Errorf("history spike: %s", finding.Ending)
}

// resolved runs one store lookup under the spike's step budget and returns
// whatever it answers — or says the lookup stalled, which is a finding of its
// own and not a silence to misread. `plane/lidmap` is the one implementation
// of that bound, shared with the capture guard and the ninety-day fill, and it
// argues why a context alone is not one.
func resolved(ctx context.Context, lookup func(context.Context) (types.JID, error)) (types.JID, error) {
	return lidmap.Bounded(ctx, spikeStepTimeout, lookup)
}

// set renders whether a request field was stated at all, for a log line that
// records which knobs a run turned.
func set(on bool) string {
	if on {
		return "set"
	}
	return "unset"
}

// stated renders whether an optional field was filled, for a log line that
// must never carry the value itself.
func stated(filled bool) string {
	if filled {
		return "stated"
	}
	return "unset"
}

// flagSupplied reports whether the operator passed a flag at all, whatever
// its value — `flag`'s own record of what the command line said.
func flagSupplied(name string) bool {
	supplied := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			supplied = true
		}
	})
	return supplied
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
