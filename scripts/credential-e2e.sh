#!/usr/bin/env sh
set -eu

export COMPOSE_PROJECT_NAME=algaguard-credential-e2e

# Private development keys remain mode 0600. On POSIX, run application
# containers as the invoking user so bind-mounted keys stay readable only by
# their owner instead of weakening their permissions.
if command -v id >/dev/null 2>&1; then
  ALGAGUARD_RUNTIME_UID=${ALGAGUARD_RUNTIME_UID:-$(id -u)}
  ALGAGUARD_RUNTIME_GID=${ALGAGUARD_RUNTIME_GID:-$(id -g)}
  export ALGAGUARD_RUNTIME_UID ALGAGUARD_RUNTIME_GID
fi

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

openssl verify -purpose sslserver \
  -CAfile .local/pki/device-ca/ca.crt \
  .local/pki/emqx/tls.crt >/dev/null
for service in \
  algaguard-mqtt-ingestion-service \
  algaguard-command-service \
  algaguard-ota-service; do
  openssl verify -purpose sslclient \
    -CAfile .local/pki/service-ca/ca.crt \
    ".local/pki/services/$service/tls.crt" >/dev/null
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
compose run --rm --no-deps --entrypoint sh command-service -c \
  'test -r /run/algaguard-pki/device-ca/ca.crt &&
   test -r /run/algaguard-pki/services/algaguard-command-service/tls.crt &&
   test -r /run/algaguard-pki/services/algaguard-command-service/tls.key'
compose run --rm --no-deps --entrypoint node command-service -e '
  const fs = require("node:fs");
  const tls = require("node:tls");
  const socket = tls.connect({
    host: "emqx",
    port: 8884,
    servername: "emqx",
    rejectUnauthorized: true,
    ca: fs.readFileSync("/run/algaguard-pki/device-ca/ca.crt"),
    cert: fs.readFileSync("/run/algaguard-pki/services/algaguard-command-service/tls.crt"),
    key: fs.readFileSync("/run/algaguard-pki/services/algaguard-command-service/tls.key")
  });
  const timeout = setTimeout(() => socket.destroy(new Error("internal MQTT TLS preflight timed out")), 10000);
  socket.once("secureConnect", () => {
    clearTimeout(timeout);
    if (!socket.authorized) {
      socket.destroy(new Error("internal MQTT TLS preflight unauthorized: " + socket.authorizationError));
      return;
    }
    socket.end();
  });
  socket.once("error", (error) => {
    clearTimeout(timeout);
    console.error("Internal MQTT TLS preflight failed: " + (error.code || "TLS_ERROR"));
    process.exitCode = 1;
  });'

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
