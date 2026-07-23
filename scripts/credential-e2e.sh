#!/usr/bin/env sh
set -eu

export COMPOSE_PROJECT_NAME=algaguard-credential-e2e

compose() {
  docker compose --env-file .env.example -f compose.yaml -f compose.application.yaml "$@"
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose ps || true
    compose logs --tail=250 || true
  fi
  if [ "${KEEP_STACK:-0}" != "1" ]; then
    compose down --remove-orphans
  fi
  trap - EXIT INT TERM
  exit "$status"
}
trap cleanup EXIT INT TERM

for file in \
  .local/pki/device-ca/ca.crt \
  .local/pki/device-ca/ca.key \
  .local/pki/service-ca/ca.crt \
  .local/pki/emqx/tls.crt \
  .local/pki/emqx/tls.key \
  .local/pki/services/algaguard-mqtt-ingestion-service/tls.crt \
  .local/pki/services/algaguard-command-service/tls.crt \
  .local/pki/services/algaguard-ota-service/tls.crt \
  .local/pki/ota-signing/signing.key \
  .local/pki/ota-signing/signing-public.pem; do
  if [ ! -f "$file" ]; then
    echo "Missing development PKI file: $file" >&2
    exit 1
  fi
done

# This named project is dedicated to the credential proof. Starting from empty
# data volumes is intentional and scoped to that project only.
compose down --volumes --remove-orphans

compose build \
  access-service \
  device-service \
  profile-service \
  telemetry-service \
  mqtt-ingestion-service \
  command-service \
  ota-service \
  realtime-service

compose up -d --wait timescaledb redis keycloak minio emqx
compose run --rm --no-deps minio-init

for service in \
  access-service \
  device-service \
  profile-service \
  telemetry-service \
  mqtt-ingestion-service \
  command-service \
  ota-service; do
  compose run --rm --no-deps "$service" node dist/scripts/migrate.js
done

compose up -d --no-build --wait \
  access-service \
  device-service \
  profile-service \
  telemetry-service \
  mqtt-ingestion-service \
  command-service \
  ota-service \
  realtime-service

npm ci
npm run test:credential
