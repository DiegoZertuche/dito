// Package testkms connects plane crypto tests to the real dev-account KMS
// (ADR-0028: the crypto path is never mocked). The one reused fixture key —
// alias/dito-dev/twin-test-fixture, us-east-1 — is the same key the TS
// integration lane uses; tests REUSE it and never create keys. When KMS is
// unreachable (no credentials) the caller's test SKIPS loudly — never a
// silent pass — unless DITO_REQUIRE_KMS=1 turns absence into a failure.
// DITO_SKIP_KMS_TESTS=1 skips explicitly (parity with the TS lane).
package testkms

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
)

// FixtureKMSTwinID is the KMS-side identity of the shared fixture twin: its
// alias is alias/dito-dev/twin-test-fixture. KMS-side identity only — seam
// rows carry twin uuids.
const FixtureKMSTwinID = "test-fixture"

// FixtureAlias is the one reused fixture key's alias. Never create keys.
const FixtureAlias = "alias/dito-dev/twin-test-fixture"

// fixtureRegion is the fixture key's home region, used when the environment
// names none.
const fixtureRegion = "us-east-1"

// Client returns a real KMS client proven able to reach the fixture key,
// skipping (or failing under DITO_REQUIRE_KMS=1) when it cannot.
func Client(t *testing.T) *kms.Client {
	t.Helper()
	if os.Getenv("DITO_SKIP_KMS_TESTS") == "1" {
		t.Skip("SKIPPED, not passed: DITO_SKIP_KMS_TESTS=1 — the real-KMS crypto tests did not run (ADR-0028: never mocked)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var opts []func(*config.LoadOptions) error
	if os.Getenv("AWS_REGION") == "" && os.Getenv("AWS_DEFAULT_REGION") == "" {
		opts = append(opts, config.WithRegion(fixtureRegion))
	}
	cfg, err := config.LoadDefaultConfig(ctx, opts...)
	var client *kms.Client
	if err == nil {
		client = kms.NewFromConfig(cfg)
		_, err = client.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: aws.String(FixtureAlias)})
	}
	if err != nil {
		if os.Getenv("DITO_REQUIRE_KMS") == "1" {
			t.Fatalf("DITO_REQUIRE_KMS=1 but the fixture KMS key is unreachable: %v", err)
		}
		t.Skipf("SKIPPED, not passed: fixture KMS key unreachable (%v) — configure AWS credentials to run the real-KMS tests (ADR-0028: never mocked)", err)
	}
	return client
}
