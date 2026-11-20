#!/usr/bin/env bash
set -euo pipefail
# Local Postgres 16 for the integration lane (ADR-0028: real Postgres, never mocked).
NAME=dito-dev-postgres
PORT="${DITO_PG_PORT:-5433}"

case "${1:-}" in
  up)
    if docker ps --format '{{.Names}}' | grep -q "^${NAME}\$"; then
      echo "${NAME} already running"
      exit 0
    fi
    docker run -d --rm --name "$NAME" \
      -e POSTGRES_USER=dito -e POSTGRES_PASSWORD=dito -e POSTGRES_DB=dito_test \
      -p "${PORT}:5432" postgres:16 >/dev/null
    for _ in $(seq 1 60); do
      if docker exec "$NAME" pg_isready -U dito -d dito_test >/dev/null 2>&1; then
        echo "postgres 16 ready on localhost:${PORT}"
        exit 0
      fi
      sleep 1
    done
    echo "postgres did not become ready" >&2
    exit 1
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: db.sh up|down" >&2
    exit 2
    ;;
esac
