#!/usr/bin/env bash
set -euo pipefail
# Recomputes db/migrations/atlas.sum after adding/editing a migration (ADR-0029).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/ensure-atlas.sh" >/dev/null
exec "$ROOT/.tools/atlas" migrate hash --dir "file://$ROOT/db/migrations"
