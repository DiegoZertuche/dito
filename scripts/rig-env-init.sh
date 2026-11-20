#!/usr/bin/env bash
# One-time rig env bootstrap (#26). Idempotent: refuses to overwrite an existing
# .env.rig so the two chain keys stay stable once minted (each chain dies with
# its own).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env.rig ]; then
  echo "REFUSED: .env.rig already exists (the HMAC keys must stay stable)"
  exit 1
fi
TWIN=$(uuidgen | tr 'A-Z' 'a-z')
COMPANY=$(uuidgen | tr 'A-Z' 'a-z')
SEAT=$(uuidgen | tr 'A-Z' 'a-z')
HMAC=$(openssl rand -hex 32)
# ...AND THE OWNER SIDE'S OWN, INDEPENDENTLY MINTED (#165; the decision on
# #157). Two chains, two secrets: the rep side's `public.audit_chain` under
# the key above, the owner side's per-company `owner.audit_chain` under this
# one. Deriving one from the other would put a value in the owner
# environment that can verify a rep-side store, which is exactly what
# ADR-0002 says the owner app must not hold. Like the key above, it dies with
# .env.rig — the chain it authenticates goes with it.
OWNERHMAC=$(openssl rand -hex 32)
# The owner app's database password (#127). Hex, so it needs no escaping
# inside the connection string below. The migration that creates dito_owner
# deliberately ships no password — a secret does not belong in a checksummed
# artifact — so this is where the rig's comes from, and
# `rig-seed-owner.ts` is what puts it on the role.
OWNERPW=$(openssl rand -hex 24)
{
  printf 'export DITO_DATABASE_URL="postgres://dito:dito@localhost:5433/dito_rig?sslmode=disable"\n'
  printf 'export DITO_TWIN_ID="%s"\n' "$TWIN"
  printf 'export DITO_COMPANY_ID="%s"\n' "$COMPANY"
  printf 'export DITO_SEAT_ID="%s"\n' "$SEAT"
  printf 'export DITO_AUDIT_HMAC_KEY="%s"\n' "$HMAC"
  # The owner web's own chain key (#165). `rig-owner.sh` carries this one and
  # deliberately does NOT carry the line above it.
  printf 'export DITO_OWNER_AUDIT_HMAC_KEY="%s"\n' "$OWNERHMAC"
  printf 'export DITO_OWNER_DB_PASSWORD="%s"\n' "$OWNERPW"
  # What the owner web connects as (#129): its own role, never the schema
  # owner's credentials. The company it serves is DITO_COMPANY_ID above.
  printf 'export DITO_OWNER_DATABASE_URL="postgres://dito_owner:%s@localhost:5433/dito_rig?sslmode=disable"\n' "$OWNERPW"
  printf 'export AWS_REGION="us-east-1"\n'
  printf 'export DITO_DRAFTING_MODEL="claude-sonnet-5"\n'
  # The rep's language and register (#172), told to the drafting execution as
  # data rather than written into its instructions. The rep notepad replaces
  # it in slice 6; until then this is the one place a deployment says how its
  # rep writes.
  printf 'export DITO_REP_LANGUAGE="Mexican Spanish, informal WhatsApp"\n'
  printf '# appended by the operator, never in chat:\n'
  printf '# export ANTHROPIC_API_KEY=...\n'
} > .env.rig
chmod 600 .env.rig
echo "ENV_WRITTEN twin=$TWIN company=$COMPANY seat=$SEAT (both hmac keys and the owner password minted, not shown)"
