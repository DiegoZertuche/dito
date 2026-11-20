// Package plane is the Dito connection plane (ADR-0005): a thin Go service
// that will embed whatsmeow and do exactly three jobs — filtered ingest into
// wa_events (after the capture guard, ADR-0023), send execution per
// ADR-0006, and rail status. Zero business logic lives here.
//
// Born in slice 1 as a module scaffold (ticket #19). The whatsmeow session,
// rail_status seam, and session store arrived with ticket #21 (cmd/plane,
// session, railstatus, wastore); the capture-guard skeleton is ticket #22
// and the executor tickets #24/#25.
package plane

// SendClass is one of the two send classes the executor enforces (ADR-0006).
type SendClass string

const (
	// SendClassCustomer requires a send_commands row referencing a recorded tap.
	SendClassCustomer SendClass = "customer_send"
	// SendClassSystem is permitted only to the rep's own self-chat JID, where
	// "self" derives exclusively from the live whatsmeow session identity.
	SendClassSystem SendClass = "system_send"
)
