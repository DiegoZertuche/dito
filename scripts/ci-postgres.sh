#!/usr/bin/env bash
# Starts the CI's Postgres from a step, not a service container, so the image
# can be pulled signed in. The public registry caps anonymous pulls by data,
# and the fast lane (ticket #390) pulls this image five times per run from
# GitHub's shared addresses: on 2026-10-12 the plane's job on `main` failed
# before it ran anything («toomanyrequests: Data limit exceeded»). A service
# container cannot log in first; a step can. Order: a saved image from the
# job's cache when there is one; otherwise a pull, signed in with the AWS
# keys the KMS steps already hold when they are present (ECR Public signs
# in through us-east-1 whatever the region; a sign-in that fails for want of
# a permission falls back to anonymous rather than failing the job), with
# retries; then the same health wait the service carried.
set -euo pipefail
IMAGE="${CI_POSTGRES_IMAGE:-public.ecr.aws/docker/library/postgres:16}"
NAME="${CI_POSTGRES_NAME:-ci-postgres}"
PORT="${CI_POSTGRES_PORT:-5433}"
SAVED="${CI_POSTGRES_SAVED:-/tmp/ci-postgres-image.tar}"

if [ -s "$SAVED" ]; then
  echo "loading the saved image"
  docker load --input "$SAVED" >/dev/null
else
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    if aws ecr-public get-login-password --region us-east-1 2>/dev/null \
      | docker login --username AWS --password-stdin public.ecr.aws >/dev/null 2>&1; then
      echo "pulling signed in"
    else
      echo "sign-in unavailable (the CI user may lack ecr-public:GetAuthorizationToken and sts:GetServiceBearerToken); pulling anonymously"
    fi
  else
    echo "AWS keys absent; pulling anonymously"
  fi
  pulled=0
  for attempt in 1 2 3 4 5; do
    if docker pull --quiet "$IMAGE" >/dev/null; then pulled=1; break; fi
    echo "pull failed (attempt $attempt); waiting $((attempt * 20)) s"
    sleep $((attempt * 20))
  done
  [ "$pulled" = 1 ] || { echo "could not pull $IMAGE" >&2; exit 1; }
  docker save --output "$SAVED" "$IMAGE"
fi

docker run --detach --name "$NAME" \
  -e POSTGRES_USER=dito -e POSTGRES_PASSWORD=dito -e POSTGRES_DB=dito_test \
  -p "${PORT}:5432" "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -U dito -d dito_test >/dev/null 2>&1; then
    echo "postgres ready on ${PORT}"
    exit 0
  fi
  sleep 2
done
echo "postgres did not become ready" >&2
docker logs "$NAME" | tail -20 >&2
exit 1
