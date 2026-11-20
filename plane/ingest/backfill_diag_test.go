package ingest

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

// The diagnostic line says WHICH conversation it reports without saying
// WHO (#119): the twin thread or not, and how many history messages the
// walk saw. A pure test — no seam, no phone — because the line's shape is
// the contract the rig session (#102) reads by name. Internal package,
// deliberately: the struct is unexported and the line is built from it.
func TestHistoryReactionShapesReportNamesTheConversationWithoutIdentity(t *testing.T) {
	var buf bytes.Buffer
	writer, flags := log.Writer(), log.Flags()
	log.SetFlags(0)
	log.SetOutput(&buf)
	t.Cleanup(func() {
		log.SetOutput(writer)
		log.SetFlags(flags)
	})

	shapes := historyReactionShapes{twinThread: true, messages: 3, accumulated: 1, keyDistinct: 1, withSenderTS: 1}
	shapes.report()

	got := buf.String()
	want := "history reactions: twin_thread=true messages=3 standalone=0 accumulated=1 key_absent=0 key_is_target=0 key_distinct=1 with_sender_ts=1 removals=0 key_restates_parent=0 key_with_participant=0 also_standalone=0"
	if !strings.Contains(got, want) {
		t.Errorf("report() = %q, want a line containing %q", got, want)
	}
}
