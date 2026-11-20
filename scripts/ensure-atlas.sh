#!/usr/bin/env bash
set -euo pipefail
# Atlas is the one shared-Postgres migration tool, version pinned at init (ADR-0029).
#
# THE VERSION LINE IS PARSED BY CI, which keys its `.tools` cache on it so a
# bump re-downloads (ticket #88). Keep it a bare `ATLAS_VERSION="vX.Y.Z"`
# assignment on one line, or use `--print-version` below.
ATLAS_VERSION="v1.3.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/.tools/atlas"

# Lets CI key a cache on the pinned version without downloading anything.
if [ "${1:-}" = "--print-version" ]; then
  echo "$ATLAS_VERSION"
  exit 0
fi

if [ -x "$BIN" ] && "$BIN" version 2>/dev/null | head -1 | grep -q "atlas version ${ATLAS_VERSION}\$"; then
  exit 0
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *)
    echo "unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

HOST="${DITO_ATLAS_HOST:-release.ariga.io}"
URL="https://${HOST}/atlas/atlas-${OS}-${ARCH}-${ATLAS_VERSION}"

mkdir -p "$ROOT/.tools"
# BOUNDED RETRY (ticket #88). One transient DNS or TLS failure on a cold
# cache used to fail the whole integration suite, and it read as a test
# failure, because this download happens inside a test's `beforeAll` by way
# of `migrate.sh`. `--retry-all-errors` is what makes `--retry` cover a DNS
# failure at all; without it curl retries only transient HTTP responses.
if ! curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
     --connect-timeout 10 --max-time 120 -o "$BIN" "$URL"; then
  # SAY WHAT COULD NOT BE REACHED. This is a build tool being fetched over
  # the network — not a broken migration, not a failing test — and a bare
  # "Command failed: migrate.sh" sends the reader somewhere else entirely.
  # That is exactly what happened on PR #87.
  cat >&2 <<MSG
ensure-atlas.sh: could not download the Atlas migration tool.

  tool:   atlas ${ATLAS_VERSION} (pinned — ADR-0029)
  host:   ${HOST}
  url:    ${URL}
  wanted: ${BIN}

This is a NETWORK failure fetching a build tool, not a migration failure and
not a test failure: nothing is wrong with the schema or the code. In CI the
.tools cache should make this a no-op, so reaching here means a cold cache
AND an unreachable host.
MSG
  rm -f "$BIN"
  exit 1
fi
chmod +x "$BIN"
"$BIN" version | head -1
