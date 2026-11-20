package ingest_test

import (
	"encoding/hex"
	"testing"

	"github.com/Dito-Core/dito/plane/ingest"
)

// The envelope byte format is a cross-language contract: the plane seals in
// Go, the twin-runtime opens with @dito/crypto (ticket #23). The fixture
// below was produced by the REAL TS implementation (@dito/crypto Dek.encrypt,
// .tools/gen-envelope-fixture.mjs) — the independent source of truth. If the
// Go side drifts from `version || iv(12) || tag(16) || ciphertext`
// AES-256-GCM, this test fails.
const (
	tsFixtureKeyHex = "9f2c5d8a1b4e7f0a3d6c9b2e5f8a1d4c7b0e3f6a9d2c5b8e1f4a7d0c3b6e9f2a"
	tsFixturePlain  = `{"v":1,"chat_jid":"5215550001@s.whatsapp.net","text":"¿me mandas 40 cajas para el jueves? — sí, va"}`
	tsFixtureBlob   = "017bac5acc4df65ce9222b798d4b4c1fbdf0fd4619c206beb2e3f212476ecea2e5d18d6fcc768c7f5fd1b69c8d96fb20178e14fd9229ca0a32012ff79325f6b2068a0d39b439a67547003d428acdb57704fb9a544232630f3291e587dede323ed2d97d1049a4fa4b22114fa05caeb3919f93e6e03061a5afe56ff93efb87257f3e7a9e76e8"
)

func fixtureKey(t *testing.T) []byte {
	t.Helper()
	key, err := hex.DecodeString(tsFixtureKeyHex)
	if err != nil {
		t.Fatalf("decoding fixture key: %v", err)
	}
	return key
}

func TestSealEnvelopeRoundTripsAndAuthenticates(t *testing.T) {
	key := fixtureKey(t)
	plain := []byte(`{"v":1,"text":"¿me apartas 12 garrafones?"}`)

	blob, err := ingest.SealEnvelope(key, plain)
	if err != nil {
		t.Fatalf("sealing: %v", err)
	}
	got, err := ingest.OpenEnvelope(key, blob)
	if err != nil {
		t.Fatalf("opening own seal: %v", err)
	}
	if string(got) != string(plain) {
		t.Fatalf("round trip mismatch: got %q want %q", got, plain)
	}

	// Tampering any single byte must fail GCM auth — flipping a bit in the
	// iv, tag, or ciphertext regions all count.
	for _, i := range []int{1, 1 + 11, 1 + 12, 1 + 12 + 15, 1 + 12 + 16, len(blob) - 1} {
		tampered := append([]byte(nil), blob...)
		tampered[i] ^= 0x01
		if _, err := ingest.OpenEnvelope(key, tampered); err == nil {
			t.Fatalf("tampered byte %d opened cleanly", i)
		}
	}

	// A wrong key must fail, never yield plaintext.
	wrongKey := append([]byte(nil), key...)
	wrongKey[0] ^= 0x01
	if _, err := ingest.OpenEnvelope(wrongKey, blob); err == nil {
		t.Fatal("wrong key opened the envelope")
	}
}

func TestOpenEnvelopeRefusesNonEnvelopes(t *testing.T) {
	key := fixtureKey(t)
	for name, blob := range map[string][]byte{
		"empty":         {},
		"short":         make([]byte, 1+12+16-1),
		"wrong version": append([]byte{0x02}, make([]byte, 40)...),
	} {
		if _, err := ingest.OpenEnvelope(key, blob); err == nil {
			t.Fatalf("%s blob opened cleanly", name)
		}
	}
}

func TestOpenEnvelopeDecryptsTSProducedBlob(t *testing.T) {
	blob, err := hex.DecodeString(tsFixtureBlob)
	if err != nil {
		t.Fatalf("decoding fixture blob: %v", err)
	}
	plain, err := ingest.OpenEnvelope(fixtureKey(t), blob)
	if err != nil {
		t.Fatalf("opening TS-produced envelope: %v", err)
	}
	if string(plain) != tsFixturePlain {
		t.Fatalf("plaintext mismatch:\n got %q\nwant %q", plain, tsFixturePlain)
	}
}
