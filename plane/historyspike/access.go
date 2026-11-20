package historyspike

import (
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
)

// What the phone says about this companion's ACCESS to the history it is
// answering about — `messageAccessStatus` on the history-sync notification,
// whose one field is `completeAccessGranted`.
//
// IT DECIDES WHETHER THE REQUEST IS WRONG OR THE GRANT IS MISSING (#216),
// which is why it is on every line that describes an answer. The transfer
// type the conversation states has a value for exactly this case —
// COMPLETE_ON_DEMAND_SYNC_WITH_MORE_MSG_ON_PRIMARY_BUT_NO_ACCESS, value 3 of
// waHistorySync.Conversation_EndOfHistoryTransferType — and the remedy for
// it is not in any request field: it is a setting on the phone (Linked
// devices → this device → Chat history → All chat history). An answer that
// carries no messages and says `access=denied` is a permission the operator
// grants, not a request the plane composes differently.
const (
	// accessGranted — the phone states that complete access is granted.
	accessGranted = "granted"
	// accessDenied — the phone states the status and it is false.
	accessDenied = "denied"
	// accessUnstated — nothing was stated: no status message, or a status
	// message whose boolean is absent. A MISSING BOOLEAN IS NOT A DENIAL
	// (Codex r1): the generated getter answers false for an absent field, so
	// reading it directly would turn silence into a phone-permission
	// diagnosis and send an operator to a setting nobody asked them to
	// change. It is what every answer so far has looked like from here,
	// because nothing read this field.
	accessUnstated = "unstated"
	// accessMixed — the chunks of one answer disagreed. Kept as its own word
	// rather than resolved, because a disagreement is itself the finding and
	// the linger's per-event lines carry each chunk's own reading.
	accessMixed = "mixed"
)

// accessOf renders a finding's access reading, and an unset one is the same
// thing the phone's silence is: nothing was said. The vocabulary stays the
// protocol's three words and gains no fourth.
func accessOf(status string) string {
	if status == "" {
		return accessUnstated
	}
	return status
}

// accessStatus renders what one notification says about access.
func accessStatus(notification *waE2E.HistorySyncNotification) string {
	status := notification.GetMessageAccessStatus()
	if status == nil || status.CompleteAccessGranted == nil {
		return accessUnstated
	}
	if status.GetCompleteAccessGranted() {
		return accessGranted
	}
	return accessDenied
}

// accessAcross folds one chunk's reading into what the answer has said so
// far, and it does not depend on the order the chunks arrived in (Codex r1):
// anything stated beats silence, agreement stands, and a disagreement is
// reported as one rather than resolved in favour of whichever landed first.
func accessAcross(sofar, arriving string) string {
	switch {
	case sofar == "" || sofar == accessUnstated:
		return arriving
	case arriving == "" || arriving == accessUnstated:
		return sofar
	case sofar == arriving:
		return sofar
	default:
		return accessMixed
	}
}

// oldestInChunk is the oldest instant the notification claims for its own
// chunk (`oldestMsgInChunkTimestampSec`, seconds), or the zero time when it
// claims none — which the lines render as `none`, never as the epoch.
func oldestInChunk(notification *waE2E.HistorySyncNotification) time.Time {
	if seconds := notification.GetOldestMsgInChunkTimestampSec(); seconds > 0 {
		return time.Unix(seconds, 0).UTC()
	}
	return time.Time{}
}
