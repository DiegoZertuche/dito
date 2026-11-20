#!/usr/bin/env bash
set -euo pipefail
# Live-rail verification protocol for ticket #21 (slice AC 1): QR link,
# restart survival, socket-drop reconnect — observed as rail_status events
# on the Postgres seam. A human with the RIG NUMBER's device performs the
# numbered steps; this script automates everything else and asserts the
# observed rail_status sequences.
#
# Rig doctrine (#4): scan ONLY with the rig number's device. Never a
# personal number.
#
# Usage: scripts/rig-link-verify.sh
#   (run from the repo root; keep a second terminal free for the plane)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG=dito-dev-postgres
TWIN_ID="${DITO_TWIN_ID:-b0a2c0de-0000-4000-8000-000000000001}"
DSN="postgres://dito:dito@localhost:${DITO_PG_PORT:-5433}/dito_test?sslmode=disable"

psql_t() {
  docker exec "$PG" psql -U dito -d dito_test -tA -c "$1"
}

# Highest rail_status id for the twin (0 when none) — the marker between steps.
marker() {
  psql_t "SELECT coalesce(max(id), 0) FROM rail_status_events WHERE twin_id = '$TWIN_ID'"
}

# Space-joined statuses recorded after the given marker.
since() {
  psql_t "SELECT string_agg(status, ' ' ORDER BY id) FROM rail_status_events WHERE twin_id = '$TWIN_ID' AND id > $1"
}

pass=0
fail=0
check() { # check <label> <observed> <extended-regex over the space-joined sequence>
  local label="$1" observed="$2" pattern="$3"
  if [[ "$observed" =~ $pattern ]]; then
    echo "  PASS  $label"
    echo "        observed: [${observed:-<none>}]"
    pass=$((pass + 1))
  else
    echo "  FAIL  $label"
    echo "        observed: [${observed:-<none>}]  (wanted to match: $pattern)"
    fail=$((fail + 1))
  fi
}

echo "== Preflight (automated) =="
"$ROOT/scripts/db.sh" up
"$ROOT/scripts/migrate.sh" "$DSN"
(cd "$ROOT/plane" && go build -o "$ROOT/.tools/dito-plane" ./cmd/plane)
echo "plane binary: $ROOT/.tools/dito-plane"
echo
echo "In your SECOND terminal, the plane runs as:"
echo
echo "  DITO_TWIN_ID=$TWIN_ID $ROOT/.tools/dito-plane"
echo

echo "== Step 1 — QR link =="
M1="$(marker)"
cat <<'EOS'
  1. Start the plane in the second terminal (command above).
  2. A QR code renders there. On the RIG NUMBER's device (never a personal
     number): WhatsApp > Linked devices > Link a device, and scan it.
  3. Wait until the second terminal logs "rail_status: linked".
EOS
read -rp "Press Enter once linked... "
S1="$(since "$M1")"
check "link: at least one qr issued, then linked" "$S1" '^qr( qr)* linked$'

echo
echo "== Step 2 — Restart survival (no re-scan) =="
M2="$(marker)"
cat <<'EOS'
  1. Stop the plane in the second terminal (Ctrl+C) — the shutdown records
     "rail_status: dropped" (the socket is down while the plane is down).
  2. Start it again with the same command.
  3. It must log "persisted session found ... resuming without re-scan"
     and then "rail_status: linked" — with NO QR code rendered.
EOS
read -rp "Press Enter once re-linked... "
S2="$(since "$M2")"
check "restart: dropped at shutdown, linked on resume, no qr" "$S2" '^dropped linked$'

echo
echo "== Step 3 — Socket drop and reconnect =="
M3="$(marker)"
cat <<'EOS'
  1. With the plane running and linked, turn the laptop's Wi-Fi OFF.
  2. Wait for the second terminal to log "rail_status: dropped".
  3. Turn Wi-Fi back ON and wait for "rail_status: linked".
EOS
read -rp "Press Enter once re-linked... "
S3="$(since "$M3")"
# Momentary flapping while the network settles still verifies the rail:
# every drop must resolve to linked, and no qr may ever appear.
check "drop: dropped then linked, no re-scan" "$S3" '^dropped( linked dropped)* linked$'

echo
echo "== Full rail_status history (this run) =="
psql_t "SELECT id, status, left(detail, 24) AS detail, occurred_at FROM rail_status_events WHERE twin_id = '$TWIN_ID' AND id > $M1 ORDER BY id" || true

echo
echo "== Result: $pass passed, $fail failed =="
if [[ $fail -gt 0 ]]; then
  exit 1
fi
echo "Live-rail verification complete: link, restart survival, drop/reconnect."
