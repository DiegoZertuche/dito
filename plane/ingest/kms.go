package ingest

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
)

// The KMS half of envelope crypto in the plane (ADR-0008), mirroring
// @dito/crypto's kms.ts: key selection derives from twin identity INSIDE
// this module — no caller can pair a twin with another twin's key — and the
// unwrap carries the twin id in the KMS encryption context, so a cross-twin
// ciphertext refuses even under the right key. Plaintext key material goes
// straight into Sealer custody; the plane process is one of ADR-0008's
// exactly-two custody points.
const (
	aliasPrefix = "alias/dito-dev/twin-"
	contextKey  = "dito:twin_id"
)

var kmsTwinIDPattern = regexp.MustCompile(`^[a-zA-Z0-9/_-]+$`)

// ErrUnprovisionedTwin marks a twin with no wrapped DEK in twin_keys — the
// binary distinguishes "not provisioned yet" (run link-only, loudly) from a
// broken seam (die).
var ErrUnprovisionedTwin = errors.New("twin has no wrapped DEK in twin_keys")

func twinAlias(kmsTwinID string) (string, error) {
	if !kmsTwinIDPattern.MatchString(kmsTwinID) {
		return "", fmt.Errorf("twin id not usable in a KMS alias: %q", kmsTwinID)
	}
	return aliasPrefix + kmsTwinID, nil
}

// UnwrapDek unwraps a twin's stored DEK through real KMS. The key is
// resolved from the twin's own alias (a twin without a key cannot unwrap
// anything), KeyId pins the blob to that key, and the encryption context
// refuses a cross-twin ciphertext (ADR-0008).
func UnwrapDek(ctx context.Context, client *kms.Client, kmsTwinID string, wrappedDek []byte) ([]byte, error) {
	alias, err := twinAlias(kmsTwinID)
	if err != nil {
		return nil, err
	}
	described, err := client.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: aws.String(alias)})
	if err != nil {
		return nil, fmt.Errorf("resolving the twin's KMS key %s: %w", alias, err)
	}
	out, err := client.Decrypt(ctx, &kms.DecryptInput{
		KeyId:             described.KeyMetadata.Arn,
		CiphertextBlob:    wrappedDek,
		EncryptionContext: map[string]string{contextKey: kmsTwinID},
	})
	if err != nil {
		return nil, fmt.Errorf("unwrapping the twin's DEK: %w", err)
	}
	return out.Plaintext, nil
}

// LoadSealer is the plane's startup path to its custody of the DEK
// (ADR-0008): load the wrapped DEK from twin_keys on the seam (homed there
// by #20; written by the twin-runtime's provisioning) and unwrap it through
// real KMS. A twin with no stored key refuses — capture without a DEK is
// impossible, and guessing is forbidden.
//
// kmsTwinID and twinID are ONE identity in production — the binary passes
// the twin's uuid for both, binding the seam row, the KMS alias, and the
// encryption context together (no caller-selectable pairing). The split
// parameter exists solely for the test suite, where the shared real-KMS
// fixture key's alias ("test-fixture") is not a uuid and creating per-test
// keys is forbidden (ADR-0028).
func LoadSealer(ctx context.Context, db *sql.DB, client *kms.Client, kmsTwinID, twinID string) (*Sealer, error) {
	var wrapped []byte
	err := db.QueryRowContext(ctx,
		"SELECT wrapped_dek FROM twin_keys WHERE twin_id = $1", twinID,
	).Scan(&wrapped)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: twin %s — provision it via the twin-runtime (ensureTwinKey → createTwinBundle → storeWrappedDek, #23)", ErrUnprovisionedTwin, twinID)
	}
	if err != nil {
		return nil, fmt.Errorf("loading the twin's wrapped DEK: %w", err)
	}
	key, err := UnwrapDek(ctx, client, kmsTwinID, wrapped)
	if err != nil {
		return nil, err
	}
	sealer, err := NewSealer(key)
	// The sealer copied the material; drop ours immediately (custody).
	for i := range key {
		key[i] = 0
	}
	return sealer, err
}
