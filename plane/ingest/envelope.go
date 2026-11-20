// Package ingest is the connection plane's filtered ingest (ADR-0005, job 1;
// ticket #22): the capture guard decides at the socket which chats may leave
// the plane (ADR-0023 skeleton — scope allowlist plus the always-in-scope
// self-chat), and what leaves is already DEK-encrypted inside the pinned
// metadata envelope on wa_events (ADR-0008). Out-of-scope traffic is dropped
// before persistence — never written anywhere. Zero business logic: guard
// rules are metadata-only config reads.
package ingest

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

// The envelope blob format shared with @dito/crypto (packages/crypto/src/dek.ts):
// version(1) || iv(12) || tag(16) || ciphertext, AES-256-GCM. The Go side
// must match the TS side byte for byte — the twin-runtime (#23) decrypts
// what the plane writes.
const (
	envelopeVersion = 0x01
	ivLength        = 12
	tagLength       = 16
)

var errNotEnvelope = errors.New("not a DEK envelope blob")

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// SealEnvelope seals plaintext under the DEK into the shared envelope blob:
// version || iv || tag || ciphertext. This is the in-plane encryption of
// ADR-0008 — content crosses the seam only inside this blob.
func SealEnvelope(key, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	iv := make([]byte, ivLength)
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	// Go's GCM emits ciphertext||tag; the shared format carries tag first.
	sealed := gcm.Seal(nil, iv, plaintext, nil)
	ciphertext := sealed[:len(sealed)-tagLength]
	tag := sealed[len(sealed)-tagLength:]
	blob := make([]byte, 0, 1+ivLength+tagLength+len(ciphertext))
	blob = append(blob, envelopeVersion)
	blob = append(blob, iv...)
	blob = append(blob, tag...)
	blob = append(blob, ciphertext...)
	return blob, nil
}

// OpenEnvelope opens a DEK envelope blob sealed by either side of the
// cross-language contract; it errors on tampering or a wrong key (GCM auth).
func OpenEnvelope(key, blob []byte) ([]byte, error) {
	if len(blob) < 1+ivLength+tagLength || blob[0] != envelopeVersion {
		return nil, errNotEnvelope
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	iv := blob[1 : 1+ivLength]
	tag := blob[1+ivLength : 1+ivLength+tagLength]
	ciphertext := blob[1+ivLength+tagLength:]
	// Go's GCM wants ciphertext||tag; the shared format carries tag first.
	sealed := make([]byte, 0, len(ciphertext)+tagLength)
	sealed = append(sealed, ciphertext...)
	sealed = append(sealed, tag...)
	return gcm.Open(nil, iv, sealed, nil)
}
