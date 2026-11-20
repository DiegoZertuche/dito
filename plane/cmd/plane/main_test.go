package main

import (
	"flag"
	"testing"
)

// The rig-only flags' DEFAULTS, pinned where they live (#216). Every one of
// them changes what a rig run does — one of them turns the plane into a
// probe, one costs a QR re-scan at the next pairing, and one puts the
// library's DEBUG log on the terminal — so "off unless the operator asks"
// is a property worth a test rather than a reading of the source.
//
// `flag`'s own record is the subject: DefValue is the string the flag was
// registered with, which is what an operator gets when they pass nothing.
func TestTheRigOnlyFlagsAreOffUntilAskedFor(t *testing.T) {
	for _, c := range []struct{ name, want string }{
		{"history-spike-chat", ""},
		{"history-spike-verbose", "false"},
		{"history-spike-account-lid", "false"},
		{"advertise-on-demand-history", "false"},
		// Zero advertises nothing at all: the cap reaches the phone only when
		// an operator names a number, and only at the next pairing.
		{"advertise-initial-sync-cap", "0"},
		{"advertise-recent-sync-days", "0"},
		{"history-spike-linger", "0s"},
		{"history-spike-inline-response", "false"},
	} {
		t.Run(c.name, func(t *testing.T) {
			registered := flag.Lookup(c.name)
			if registered == nil {
				t.Fatalf("no flag named %q — the mode's command line moved", c.name)
			}
			if registered.DefValue != c.want {
				t.Errorf("default = %q, want %q", registered.DefValue, c.want)
			}
		})
	}
}

// Neither the addressing nor the anchor end is a switch, and each default is
// what runs 1 through 3 asked with: a default that moved would make the
// protocol's control arm measure something other than the control.
func TestTheSpikeAsksTheWayRunsOneToThreeDidUnlessToldOtherwise(t *testing.T) {
	for _, c := range []struct{ name, want string }{
		{"history-spike-address", "pn"},
		{"history-spike-anchor", "newest"},
		{"history-spike-timestamp-unit", "seconds"},
	} {
		t.Run(c.name, func(t *testing.T) {
			registered := flag.Lookup(c.name)
			if registered == nil {
				t.Fatalf("no flag named %q — the mode's command line moved", c.name)
			}
			if registered.DefValue != c.want {
				t.Errorf("default = %q, want %q", registered.DefValue, c.want)
			}
		})
	}
}

// The wait is not a switch, and its default is the one number an orchestrator
// plans a rig session around.
func TestTheSpikeWaitsNinetySecondsUnlessToldOtherwise(t *testing.T) {
	registered := flag.Lookup("history-spike-wait")
	if registered == nil {
		t.Fatal("no flag named \"history-spike-wait\" — the mode's command line moved")
	}
	if registered.DefValue != "1m30s" {
		t.Errorf("default = %q, want %q", registered.DefValue, "1m30s")
	}
}
