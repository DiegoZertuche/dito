#!/usr/bin/env bash
set -euo pipefail
# Applies db/migrations to the given database URL via the pinned Atlas (ADR-0029).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/ensure-atlas.sh" >/dev/null
URL="${1:-${DITO_DATABASE_URL:-postgres://dito:dito@localhost:5433/dito_test?sslmode=disable}}"
# Scope Atlas to the seam's schema (public): the same rig database also
# hosts the plane's whatsmeow session store in its own library-managed
# `whatsmeow` schema (ticket #21; plane/wastore mirrors this split from
# the other side — three planes, one laptop Postgres) and it must stay
# invisible to Atlas — a foreign schema is neither "dirt" nor ever
# touched; without the scope, Atlas refuses the database as "not clean"
# the moment the plane has run against it.
# Exactly zero or one search_path, and the one must be public — duplicate
# occurrences are refused outright, since URL parsers disagree on whether
# the first or last value wins.
stripped=${URL//search_path=/}
occurrences=$(((${#URL} - ${#stripped}) / 12))
if [ "$occurrences" -gt 1 ]; then
  echo "migrate.sh: refusing URL with multiple search_path parameters" >&2
  exit 1
fi
case "$URL" in
  *search_path=public\&* | *search_path=public) ;;
  *search_path=*)
    echo "migrate.sh: refusing URL with a non-public search_path — seam migrations apply only to the public schema" >&2
    exit 1
    ;;
  *\?*) URL="${URL}&search_path=public" ;;
  *) URL="${URL}?search_path=public" ;;
esac
exec "$ROOT/.tools/atlas" migrate apply --dir "file://$ROOT/db/migrations" --url "$URL"
