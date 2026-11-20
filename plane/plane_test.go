package plane

import "testing"

// Placeholder (ticket #19): plane behavior — guard matrix, envelope encoding,
// executor semantics — arrives with ticket #21. This test pins the module
// compiles under `go test` and the seam send-class strings match the schema's
// CHECK constraint values (independent truth: ADR-0006 / db/migrations).
func TestSendClassContractStrings(t *testing.T) {
	if got, want := string(SendClassCustomer), "customer_send"; got != want {
		t.Fatalf("SendClassCustomer = %q, want %q", got, want)
	}
	if got, want := string(SendClassSystem), "system_send"; got != want {
		t.Fatalf("SendClassSystem = %q, want %q", got, want)
	}
}
