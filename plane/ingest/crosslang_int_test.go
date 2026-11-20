package ingest_test

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/ingest"
)

// The load-bearing cross-language compatibility tests (tickets #22, #100):
// the twin-runtime (#23) must decrypt AND decode what the plane writes, so a
// Go-sealed envelope is opened HERE by the real @dito/crypto and read by the
// real @dito/seam decoder — the built packages, not re-implementations.
// Requires node and the built dists (`pnpm build`); absent locally they SKIP
// loudly, and the CI integration lane sets DITO_REQUIRE_CROSSLANG=1 so
// absence is never a green there.

func repoRoot(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locating repo root")
	}
	return filepath.Join(filepath.Dir(self), "..", "..")
}

// tsDist locates node plus the built entry point of each named workspace
// package, as file URLs an ES module import can name, KEYED BY PACKAGE — a
// map rather than a positional slice, so a caller names the dist it wants
// instead of trusting an argument order nothing checks.
func tsDist(t *testing.T, pkgs ...string) (node string, dists map[string]string) {
	t.Helper()
	skip := func(format string, args ...any) {
		t.Helper()
		if os.Getenv("DITO_REQUIRE_CROSSLANG") == "1" {
			t.Fatalf("DITO_REQUIRE_CROSSLANG=1 but "+format, args...)
		}
		t.Skipf("SKIPPED, not passed: "+format, args...)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		skip("node is not on PATH — the TS side of the cross-language test cannot run")
	}
	dists = make(map[string]string, len(pkgs))
	for _, pkg := range pkgs {
		dist := filepath.Join(repoRoot(t), "packages", pkg, "dist", "index.js")
		if _, err := os.Stat(dist); err != nil {
			skip("@dito/%s is not built (%s missing) — run `pnpm build`", pkg, dist)
		}
		abs, err := filepath.Abs(dist)
		if err != nil {
			t.Fatalf("resolving dist path: %v", err)
		}
		dists[pkg] = (&url.URL{Scheme: "file", Path: filepath.ToSlash(abs)}).String()
	}
	return node, dists
}

// runInNode runs one ES-module script under node with the DEK material and a
// sealed blob on stdin as hex — the plumbing every side of this contract
// shares. It returns the script's stdout, or the failure with node's stderr
// attached, which is how a TS-side REFUSAL reaches an assertion here.
func runInNode(node, script string, key, blob []byte) (string, error) {
	cmd := exec.Command(node, "--input-type=module", "-e", script)
	cmd.Stdin = bytes.NewReader([]byte(hex.EncodeToString(key) + "\n" + hex.EncodeToString(blob) + "\n"))
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w: %s", err, stderr.String())
	}
	return stdout.String(), nil
}

func TestTSCryptoOpensAPlaneSealedEnvelope(t *testing.T) {
	node, dists := tsDist(t, "crypto")
	distURL := dists["crypto"]

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generating key: %v", err)
	}
	sealer, err := ingest.NewSealer(key)
	if err != nil {
		t.Fatalf("building sealer: %v", err)
	}
	// Multibyte UTF-8 on purpose: the rig speaks Spanish.
	plaintext := []byte(`{"v":1,"chat_jid":"5215550001@s.whatsapp.net","text":"¿me apartas 12 garrafones? — sí, va"}`)
	blob, err := sealer.Seal(plaintext)
	if err != nil {
		t.Fatalf("sealing: %v", err)
	}

	// The real @dito/crypto opens the blob: createDekFromMaterial + decrypt.
	script := fmt.Sprintf(`
import { createDekFromMaterial } from %q;
let input = "";
for await (const chunk of process.stdin) input += chunk;
const [keyHex, blobHex] = input.trim().split("\n");
const dek = createDekFromMaterial(Buffer.from(keyHex, "hex"));
process.stdout.write(Buffer.from(dek.decrypt(Buffer.from(blobHex, "hex"))));
`, distURL)
	got, err := runInNode(node, script, key, blob)
	if err != nil {
		t.Fatalf("@dito/crypto could not decrypt the plane-sealed envelope: %v", err)
	}
	if got != string(plaintext) {
		t.Fatalf("TS-decrypted plaintext mismatch:\n got %q\nwant %q", got, plaintext)
	}

	// And the TS side must refuse a tampered blob — auth must hold across
	// the language boundary too.
	tampered := append([]byte(nil), blob...)
	tampered[len(tampered)-1] ^= 0x01
	if _, err := runInNode(node, script, key, tampered); err == nil {
		t.Fatal("@dito/crypto decrypted a tampered plane-sealed envelope")
	}
}

// The reaction half of the same contract (ticket #100, ADR-0041). The
// deploy-order rule is that the runtime speaks 'reaction' BEFORE the plane
// emits one (#97 shipped the decoder); this is the test that proves the two
// halves actually meet. It does not seal a hand-built payload — it runs a
// real rail delivery through the real capture path and hands the row's own
// payload_enc to the runtime's own decoder in node. What the plane writes is
// therefore exactly what is decoded.
func TestTSSeamDecodesAPlaneWrittenReaction(t *testing.T) {
	node, dists := tsDist(t, "crypto", "seam")
	cryptoURL, seamURL := dists["crypto"], dists["seam"]
	h := newHarness(t)
	customer := types.NewJID("5215550031", types.DefaultUserServer)
	h.allow(t, customer.String())
	target := h.msgID("X0")
	at := time.Date(2026, 8, 31, 19, 0, 0, 0, time.UTC)
	senderTs := int64(1756672800456)

	// A set; on the same target a removal — the two shapes whose wire
	// difference is a single empty string; and one whose rail sender
	// timestamp is an int64 no JSON number holds exactly.
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("X1"), at, target, "👍", senderTs))
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("X2"), at.Add(time.Minute), target, "", senderTs+60000))
	unreadableAt := at.Add(2 * time.Minute)
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("X3"), unreadableAt, target, "👍", math.MaxInt64))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("want 3 reaction rows to hand across the boundary, got %d", len(rows))
	}

	// The set: every field the pinned contract promises, in the decoder's own
	// camelCase, with push_name and backfill absent (the rail supplied
	// neither) rather than stamped empty.
	got := mustDecodeInTS(t, node, cryptoURL, seamURL, "decodeWaReactionPayload", h.key, rows[0].payloadEnc)
	want := map[string]any{
		"chatJid":    customer.String(),
		"senderJid":  customer.String(),
		"fromMe":     false,
		"messageId":  h.msgID("X1"),
		"reactionTo": target,
		"emoji":      "👍",
		"senderTsMs": float64(senderTs),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("@dito/seam decoded the plane's reaction as %#v, want %#v", got, want)
	}

	// The removal: the empty string is the signal, so the key must survive
	// the crossing — a decoder that saw no emoji at all could not tell a
	// retraction from a malformed row.
	gotRemoval := mustDecodeInTS(t, node, cryptoURL, seamURL, "decodeWaReactionPayload", h.key, rows[1].payloadEnc)
	emoji, present := gotRemoval["emoji"]
	if !present || emoji != "" {
		t.Errorf("removal decoded with emoji %#v (present=%v), want the empty string present", emoji, present)
	}
	if gotRemoval["reactionTo"] != target {
		t.Errorf("removal decoded reactionTo = %#v, want %q", gotRemoval["reactionTo"], target)
	}

	// THE POISON ROW THE PLANE MUST NEVER WRITE (Codex r1-1). The rail's
	// sender timestamp is an int64 the counterparty's client fills in; the
	// decoder refuses anything outside JavaScript's safe-integer range, and
	// a row it refuses stays pending forever with every later event for that
	// twin behind it. So the plane normalizes an unreadable instant to the
	// delivery instant, and this is where that is PROVEN — the runtime's own
	// decoder reads the row rather than throwing.
	gotUnreadable := mustDecodeInTS(t, node, cryptoURL, seamURL, "decodeWaReactionPayload", h.key, rows[2].payloadEnc)
	if want := float64(unreadableAt.UnixMilli()); gotUnreadable["senderTsMs"] != want {
		t.Errorf("unreadable rail timestamp decoded as senderTsMs %#v, want the delivery instant %v", gotUnreadable["senderTsMs"], want)
	}

	// And the plane's reaction bytes are NOT readable as a message: the husk
	// cannot come back by another door. The runtime dispatches on
	// event_type, and each shape has its own decoder that refuses the other
	// (#97) — proven here against the plane's real bytes.
	if _, err := decodeInTS(node, cryptoURL, seamURL, "decodeWaMessagePayload", h.key, rows[0].payloadEnc); err == nil {
		t.Error("@dito/seam read the plane's reaction as a message — a gesture must never decode as speech (ADR-0041)")
	}
}

// mustDecodeInTS is decodeInTS with the decoded object handed back and any
// refusal failing the test — the shape the positive assertions need.
func mustDecodeInTS(t *testing.T, node, cryptoURL, seamURL, decoder string, key, blob []byte) map[string]any {
	t.Helper()
	out, err := decodeInTS(node, cryptoURL, seamURL, decoder, key, blob)
	if err != nil {
		t.Fatalf("@dito/seam's %s could not read the plane's row: %v", decoder, err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("%s returned something that is not a JSON object (%q): %v", decoder, out, err)
	}
	return decoded
}

// decodeInTS runs one of the runtime's real decoders, from the BUILT
// @dito/seam, over bytes the plane wrote, and returns what it printed — or
// the decoder's refusal, which is what the "must not decode" assertion reads.
func decodeInTS(node, cryptoURL, seamURL, decoder string, key, blob []byte) (string, error) {
	script := fmt.Sprintf(`
import { %s } from %q;
import { createDekFromMaterial } from %q;
let input = "";
for await (const chunk of process.stdin) input += chunk;
const [keyHex, blobHex] = input.trim().split("\n");
const dek = createDekFromMaterial(Buffer.from(keyHex, "hex"));
process.stdout.write(JSON.stringify(%s(dek, Buffer.from(blobHex, "hex"))));
`, decoder, seamURL, cryptoURL, decoder)
	return runInNode(node, script, key, blob)
}

// The BACKFILL half of the same contract (ticket #101, ADR-0041's "backfill
// walks both history shapes"). History's two shapes reach the seam through
// their own normalization, and one of them has an identity the plane
// SYNTHESIZES — so what the runtime reads back is worth proving with the
// runtime's own decoder rather than assuming, exactly as the live half was.
// Again no hand-built payload: a constructed history blob goes through the
// real capture path and the rows' own bytes go to node.
func TestTSSeamDecodesAPlaneWrittenBackfilledReaction(t *testing.T) {
	node, dists := tsDist(t, "crypto", "seam")
	cryptoURL, seamURL := dists["crypto"], dists["seam"]
	h := newHarness(t)
	customer := types.NewJID("5215550053", types.DefaultUserServer)
	h.allow(t, customer.String())
	target := h.msgID("BX0")
	at := time.Date(2026, 8, 30, 22, 0, 0, 0, time.UTC)
	senderTs := int64(1756591200789)

	// The standalone shape (its own stanza id), and the accumulated shape
	// in the reading that has no rail id — the synthetic one, which is the
	// row whose message_id no rail ever minted.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		historyReaction(customer.String(), h.msgID("BX1"), target, "👍", at, historyReactionOpts{senderTsMS: senderTs}),
		withReactions(
			webMsg(customer.String(), target, "van 20 bultos", at, webMsgOpts{fromMe: true}),
			accumulatedEntry("❤️", accumulatedOpts{noKey: true}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("standalone + target + accumulated: want 3 rows to hand across the boundary, got %d", len(rows))
	}

	// The standalone: the pinned shape in the decoder's own camelCase, with
	// the backfill marker the runtime routes on (context only, never a
	// draft) present and true.
	got := mustDecodeInTS(t, node, cryptoURL, seamURL, "decodeWaReactionPayload", h.key, rows[0].payloadEnc)
	want := map[string]any{
		"chatJid":    customer.String(),
		"senderJid":  customer.String(),
		"fromMe":     false,
		"messageId":  h.msgID("BX1"),
		"reactionTo": target,
		"emoji":      "👍",
		"senderTsMs": float64(senderTs),
		"backfill":   true,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("@dito/seam decoded the standalone history reaction as %#v, want %#v", got, want)
	}

	// The accumulated one, synthetic id and all: the plane must never emit a
	// payload its own pinned decoder refuses, and a composed message_id is
	// exactly the kind of value that would find out.
	gotAccumulated := mustDecodeInTS(t, node, cryptoURL, seamURL, "decodeWaReactionPayload", h.key, rows[2].payloadEnc)
	// The reactor is the ENTRY's, never the parent's: this target is the
	// rep's own message, and the gesture on it is the customer's.
	wantAccumulated := map[string]any{
		"chatJid":    customer.String(),
		"senderJid":  customer.String(),
		"fromMe":     false,
		"messageId":  target + ":r:" + customer.String() + ":" + strconv.FormatInt(at.UnixMilli(), 10),
		"reactionTo": target,
		"emoji":      "❤️",
		"senderTsMs": float64(at.UnixMilli()),
		"backfill":   true,
	}
	if !reflect.DeepEqual(gotAccumulated, wantAccumulated) {
		t.Errorf("@dito/seam decoded the accumulated history reaction as %#v, want %#v", gotAccumulated, wantAccumulated)
	}

	// And neither is readable as a message: the husk cannot come back by
	// the history door either.
	if _, err := decodeInTS(node, cryptoURL, seamURL, "decodeWaMessagePayload", h.key, rows[0].payloadEnc); err == nil {
		t.Error("@dito/seam read a history reaction as a message — a gesture must never decode as speech (ADR-0041)")
	}
}

// The OPAQUE half of the same contract (ticket #125, ADR-0042). The
// deploy-order rule is that the runtime speaks a kind BEFORE the plane emits
// one — #124 shipped the decoder, the placeholder and the fold — and this is
// the test that proves the two halves actually meet. As with the reaction
// half, nothing is sealed by hand: real rail deliveries go through the real
// capture path and each row's own payload_enc is handed to the runtime's own
// decoder in node.
func TestTSSeamDecodesAPlaneWrittenOpaqueDelivery(t *testing.T) {
	node, dists := tsDist(t, "crypto", "seam")
	cryptoURL, seamURL := dists["crypto"], dists["seam"]
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 9, 1, 13, 0, 0, 0, time.UTC)

	// One of each reason, because `reason` is the one field the decoder
	// checks against a CLOSED set: a photo the seam has no slot for, a
	// delivery the rail could not decrypt, and a gesture pointing at nothing.
	// Then the shape whose identity the plane composes rather than reads —
	// an id-less delivery, whose message_id no rail ever minted.
	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("CL1"), at,
		&waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}))
	h.ing.HandleEvent(undecryptableDelivery(customer, customer, false, h.msgID("CL2"), at.Add(time.Minute)))
	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("CL3"), at.Add(2*time.Minute),
		&waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Text: proto.String("👍")}}))
	h.ing.HandleEvent(railDelivery(customer, customer, false, "", at.Add(3*time.Minute),
		&waE2E.Message{AudioMessage: &waE2E.AudioMessage{}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 4 {
		t.Fatalf("want 4 opaque rows to hand across the boundary, got %d", len(rows))
	}

	// The photo: every field the pinned contract promises, in the decoder's
	// own camelCase, with push_name and backfill absent (the rail supplied
	// neither) rather than stamped empty. `messageId` is THE ROW'S IDENTITY,
	// suffixed — which is how the runtime reads back the message this row
	// stands for and folds a readable re-delivery over it.
	got := mustDecodeInTS(t, node, cryptoURL, seamURL, "decodeWaOpaquePayload", h.key, rows[0].payloadEnc)
	want := map[string]any{
		"chatJid":    customer.String(),
		"senderJid":  customer.String(),
		"fromMe":     false,
		"messageId":  h.msgID("CL1") + ":opaque",
		"kind":       "imageMessage",
		"reason":     "no_slot",
		"senderTsMs": float64(at.UnixMilli()),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("@dito/seam decoded the plane's opaque row as %#v, want %#v", got, want)
	}

	// The other two reasons, read by the same decoder: `reason` is the plane's
	// own closed vocabulary and a value outside it is refused, so a spelling
	// drift between the two halves would fail here rather than in a rig.
	undecryptable := mustDecodeInTS(t, node, cryptoURL, seamURL, "decodeWaOpaquePayload", h.key, rows[1].payloadEnc)
	if undecryptable["reason"] != "undecryptable" || undecryptable["kind"] != "undecryptable" {
		t.Errorf("undecryptable row decoded reason/kind = %#v/%#v, want undecryptable/undecryptable", undecryptable["reason"], undecryptable["kind"])
	}
	malformed := mustDecodeInTS(t, node, cryptoURL, seamURL, "decodeWaOpaquePayload", h.key, rows[2].payloadEnc)
	if malformed["reason"] != "malformed" || malformed["kind"] != "reactionMessage/reaction_to" {
		t.Errorf("malformed row decoded reason/kind = %#v/%#v, want malformed and reactionMessage/reaction_to", malformed["reason"], malformed["kind"])
	}

	// The id-less shape, hash identity and all: the plane must never emit a
	// payload its own pinned decoder refuses, and a composed message_id is
	// exactly the kind of value that would find out.
	idless := mustDecodeInTS(t, node, cryptoURL, seamURL, "decodeWaOpaquePayload", h.key, rows[3].payloadEnc)
	id, _ := idless["messageId"].(string)
	if !strings.HasPrefix(id, "opaque:") {
		t.Errorf("id-less row decoded messageId = %#v, want the composed opaque:<hash> identity", idless["messageId"])
	}

	// AND THE PLANE'S OPAQUE BYTES ARE NOT READABLE AS EITHER OTHER SHAPE.
	// The runtime dispatches on event_type and each shape has its own decoder
	// that refuses the others — proven here against the plane's real bytes, so
	// an opaque row can never be read as speech or as a gesture.
	for _, decoder := range []string{"decodeWaMessagePayload", "decodeWaReactionPayload"} {
		for i, row := range rows {
			if _, err := decodeInTS(node, cryptoURL, seamURL, decoder, h.key, row.payloadEnc); err == nil {
				t.Errorf("@dito/seam's %s read the plane's opaque row %d — a delivery the plane could not read must never decode as one it could (ADR-0042)", decoder, i)
			}
		}
	}
}
