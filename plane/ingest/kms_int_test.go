package ingest_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/google/uuid"

	"github.com/Dito-Core/dito/plane/ingest"
	"github.com/Dito-Core/dito/plane/internal/testkms"
)

// Real dev-account KMS, the one reused fixture key (ADR-0028: the crypto
// path is never mocked). KMS itself is the independent source of truth:
// GenerateDataKey hands back plaintext + ciphertext, and UnwrapDek must
// recover exactly that plaintext through a real Decrypt.

// generateWrappedDek mints a fresh DEK under the fixture key with the shared
// encryption context — the same wrap the TS provisioning path
// (generateWrappedDek in @dito/crypto) stores in twin_keys.
func generateWrappedDek(t *testing.T, client *kms.Client) (plaintext, wrapped []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId:             aws.String(testkms.FixtureAlias),
		KeySpec:           kmstypes.DataKeySpecAes256,
		EncryptionContext: map[string]string{"dito:twin_id": testkms.FixtureKMSTwinID},
	})
	if err != nil {
		t.Fatalf("KMS GenerateDataKey: %v", err)
	}
	return out.Plaintext, out.CiphertextBlob
}

func TestUnwrapDekRecoversTheKMSWrappedKey(t *testing.T) {
	client := testkms.Client(t)
	plain, wrapped := generateWrappedDek(t, client)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	got, err := ingest.UnwrapDek(ctx, client, testkms.FixtureKMSTwinID, wrapped)
	if err != nil {
		t.Fatalf("UnwrapDek under the fixture key: %v", err)
	}
	if string(got) != string(plain) {
		t.Fatal("UnwrapDek returned different key material than KMS generated")
	}
}

func TestUnwrapDekRefusesACiphertextOutsideTheTwinContext(t *testing.T) {
	client := testkms.Client(t)
	// Wrapped under the same key but WITHOUT the twin's encryption context:
	// the unwrap must refuse — the context binds the wrap to the twin
	// (ADR-0008), so a context mismatch is a wrong-twin ciphertext.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId:   aws.String(testkms.FixtureAlias),
		KeySpec: kmstypes.DataKeySpecAes256,
	})
	if err != nil {
		t.Fatalf("KMS GenerateDataKey (no context): %v", err)
	}
	if _, err := ingest.UnwrapDek(ctx, client, testkms.FixtureKMSTwinID, out.CiphertextBlob); err == nil {
		t.Fatal("UnwrapDek accepted a ciphertext wrapped outside the twin's encryption context")
	}
}

func TestUnwrapDekRefusesATwinWithoutAKey(t *testing.T) {
	client := testkms.Client(t)
	_, wrapped := generateWrappedDek(t, client)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// No alias exists for this twin — resolution must refuse, never guess a
	// key (mirrors resolveTwinKeyArn in @dito/crypto).
	if _, err := ingest.UnwrapDek(ctx, client, "twin-with-no-key-"+uuid.NewString()[:8], wrapped); err == nil {
		t.Fatal("UnwrapDek accepted a twin with no KMS key")
	}
}

// TestLoadSealerFromTwinKeys is the plane's full startup path (ADR-0008):
// the wrapped DEK rests in twin_keys on the seam (written by the
// twin-runtime's provisioning, #20/#23), the plane loads it, unwraps via
// real KMS, and seals captured content that the same DEK material opens.
func TestLoadSealerFromTwinKeys(t *testing.T) {
	client := testkms.Client(t)
	db := seamDB(t)
	plain, wrapped := generateWrappedDek(t, client)

	twinID := uuid.NewString()
	if _, err := db.Exec("INSERT INTO twin_keys (twin_id, wrapped_dek) VALUES ($1, $2)", twinID, wrapped); err != nil {
		t.Fatalf("seeding twin_keys: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sealer, err := ingest.LoadSealer(ctx, db, client, testkms.FixtureKMSTwinID, twinID)
	if err != nil {
		t.Fatalf("LoadSealer: %v", err)
	}
	blob, err := sealer.Seal([]byte("¿me mandas 40 cajas para el jueves?"))
	if err != nil {
		t.Fatalf("sealing under the loaded DEK: %v", err)
	}
	got, err := ingest.OpenEnvelope(plain, blob)
	if err != nil {
		t.Fatalf("the KMS-generated key does not open what the loaded sealer sealed: %v", err)
	}
	if string(got) != "¿me mandas 40 cajas para el jueves?" {
		t.Fatalf("round trip mismatch: %q", got)
	}
}

func TestLoadSealerRefusesAnUnprovisionedTwin(t *testing.T) {
	client := testkms.Client(t)
	db := seamDB(t)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := ingest.LoadSealer(ctx, db, client, testkms.FixtureKMSTwinID, uuid.NewString())
	if err == nil {
		t.Fatal("LoadSealer returned a sealer for a twin with no twin_keys row")
	}
	if !errors.Is(err, ingest.ErrUnprovisionedTwin) {
		t.Errorf("the refusal must be ErrUnprovisionedTwin so the binary can tell it from a broken seam; got: %v", err)
	}
	if !strings.Contains(err.Error(), "provision") {
		t.Errorf("the refusal should point at provisioning (twin-runtime, #23); got: %v", err)
	}
}
