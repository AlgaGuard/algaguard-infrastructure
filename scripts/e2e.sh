#!/usr/bin/env sh
set -eu

compose() {
  docker compose --env-file .env.example -f compose.yaml -f compose.application.yaml "$@"
}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose ps
    compose logs --tail=200
  fi
  if [ "${KEEP_STACK:-0}" != "1" ]; then
    compose down --remove-orphans
  fi
  trap - EXIT INT TERM
  exit "$status"
}
trap cleanup EXIT INT TERM

compose build access-service device-service telemetry-service mqtt-ingestion-service realtime-service
compose up -d --wait timescaledb redis keycloak emqx
for service in access-service device-service telemetry-service mqtt-ingestion-service; do
  compose run --rm --no-deps "$service" node dist/scripts/migrate.js
done
compose up -d --no-build --wait access-service device-service telemetry-service mqtt-ingestion-service realtime-service
npm ci
npm run test:identity
