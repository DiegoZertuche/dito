package historyspike

import (
	"fmt"
	"math"

	"go.mau.fi/whatsmeow/store"
	"google.golang.org/protobuf/proto"
)

// AdvertiseOnDemandHistory tells the phone, at pairing, that this device is
// ready to receive history on demand — one field of the device properties
// whatsmeow sends in the registration payload
// (store.DeviceProps.HistorySyncConfig, which ships it unset).
//
// WHY IT IS A SWITCH AND NOT THE DEFAULT (ticket #216). A device that has
// already paired advertised whatever it advertised then; properties are read
// once, when the pairing payload is built, so throwing this makes no
// difference to a live session and every difference to the next one. The
// spike's first question is whether the phone answers a rig that paired
// WITHOUT it; only if that is declined is the rig re-paired with it thrown,
// which is a re-scan of the QR and a cost the operator pays deliberately.
// Off by default is therefore the honest default: the rig pairs today's way
// unless someone asks for the other.
//
// It changes exactly this one property and nothing else about pairing — a
// test pins that, because the properties also carry the storage quota, the
// sync-day limits and the platform the rig presents itself as, and a spike
// that quietly changed one of those would change what the phone pushes at
// link time for reasons nobody asked for.
func AdvertiseOnDemandHistory() {
	store.DeviceProps.HistorySyncConfig.OnDemandReady = proto.Bool(true)
}

// AdvertiseInitialSyncCap tells the phone, at pairing, to send at most n
// messages per chat in the INITIAL history sync — one more field of the same
// device properties (`initialSyncMaxMessagesPerChat`, field 20 of
// DeviceProps.HistorySyncConfig, which the library ships unset).
//
// WHY IT IS THE OTHER HALF OF THE ON-DEMAND QUESTION (#216, spec #214
// decision 7(b)). Link day drops the initial push at the socket and means to
// ask for each scoped chat's history on demand afterwards — and if a primary
// will not resend what it already transferred, then every later request is
// for messages it believes this device already has. Capping the initial push
// makes the two halves consistent: the companion is given little, so the
// on-demand ask is for something it never had.
//
// IT SETS EXACTLY THAT ONE FIELD, and the proto is why: every entry of
// HistorySyncConfig is an independent `optional`
// (proto/waCompanionReg/WACompanionReg.proto:34-59), and nothing in it or in
// whatsmeow makes field 20's effect depend on `fullSyncDaysLimit` (field 1)
// or `recentSyncDaysLimit` (field 5). Those two are the next pairing's knobs
// if this one proves insufficient; a pairing is the expensive act, and
// changing three fields in one would leave nothing measured.
//
// Like the readiness switch it takes effect at the NEXT pairing only, so
// throwing it on a live session changes nothing.
func AdvertiseInitialSyncCap(n uint32) {
	store.DeviceProps.HistorySyncConfig.InitialSyncMaxMessagesPerChat = proto.Uint32(n)
}

// ParseInitialSyncCap reads the cap an operator asked for. Zero advertises
// nothing at all, which is how every run so far has paired.
func ParseInitialSyncCap(requested uint64) (uint32, error) {
	return advertisedLimit(requested, "a cap")
}

// ParseRecentSyncDays reads the recent-sync window an operator asked for.
// Zero advertises nothing, as every pairing so far has.
func ParseRecentSyncDays(requested uint64) (uint32, error) {
	return advertisedLimit(requested, "a window")
}

// advertisedLimit is the one rule both pairing numbers are read by, and it
// REFUSES WHAT THE FIELD CANNOT CARRY (Codex r1 on the cap). The flags are
// platform `uint`s, sixty-four bits wide here, while the properties are
// uint32 — so `4294967297` would be advertised as 1 while the startup line
// said 4294967297, and the pairing would measure a number nobody asked for.
// That is not a wasted flag but a wasted PAIRING, which is the expensive act
// in this whole investigation (#216).
func advertisedLimit(requested uint64, what string) (uint32, error) {
	if requested > math.MaxUint32 {
		return 0, fmt.Errorf("%s of %d is more than the device property can carry (at most %d)", what, requested, uint64(math.MaxUint32))
	}
	return uint32(requested), nil
}

// AdvertiseRecentSyncDays tells the phone, at pairing, to push only the last
// n days of each chat — `recentSyncDaysLimit`, field 5 of
// DeviceProps.HistorySyncConfig, which the library ships unset.
//
// WHY THIS IS THE NEXT KNOB (#216). With LID addressing the phone answers
// every on-demand request within seconds, on both chats, at either anchor,
// with and without accountLid — and every answer carries one conversation
// and ZERO messages. The seam holds exactly what the pairing push delivered
// and nothing older exists on that phone, so the working reading is that a
// primary will not resend what it has already pushed: there is nothing
// undelivered for a request to return. Re-pairing with the per-chat cap
// (field 20) changed nothing — the initial chunks still carried thirty and
// fifty-four messages — so that field alone is not honoured.
//
// A DAYS WINDOW IS THE OTHER WAY TO MAKE THE PUSH SMALLER. If the phone
// honours it where it ignored the count, the days before the window become
// undelivered, and an on-demand request from the window's own oldest anchor
// has something to return. That is the one experiment left that can
// distinguish "will not resend" from "will not serve at all".
//
// Like the other two switches it takes effect at the NEXT pairing only, and
// it sets exactly this one field: every entry of HistorySyncConfig is an
// independent optional (proto/waCompanionReg/WACompanionReg.proto:34-59),
// and the operator may combine the switches or throw them one at a time.
func AdvertiseRecentSyncDays(n uint32) {
	store.DeviceProps.HistorySyncConfig.RecentSyncDaysLimit = proto.Uint32(n)
}
