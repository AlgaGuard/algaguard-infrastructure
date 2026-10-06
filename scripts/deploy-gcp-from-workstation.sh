#!/usr/bin/env bash
# Ships one release to the GCP development VM from a workstation that has the
# Google Cloud CLI signed in (gcloud auth login): renders release.env from the
# pinned image commits, copies the bundle over IAP-tunnelled SSH and runs
# scripts/deploy-gcp.sh on the VM. Images must already be in Artifact Registry
# under <registry>/algaguard/<service>:<commit>.
set -euo pipefail

project=${GCP_PROJECT:?set GCP_PROJECT, e.g. algaguard-dev-775943}
zone=${GCP_ZONE:-asia-southeast1-b}
instance=${GCP_INSTANCE:-algaguard-dev}
registry_host=${GCP_REGISTRY_HOST:-asia-southeast1-docker.pkg.dev}
device_sha=${DEVICE_SERVICE_SHA:?set DEVICE_SERVICE_SHA to the device-service image commit}
gcloud=${GCLOUD:-gcloud}

cd "$(dirname "$0")/.."
infra_sha=$(git rev-parse HEAD)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

filter='. + {"device-service": $device} | to_entries[] |
  "\(.key|ascii_upcase|gsub("-";"_"))_SHA=\(.value)"'
jq -r --arg device "$device_sha" "$filter" aws/development-supporting-images.json >"$work/release.env"
cat >>"$work/release.env" <<EOF
COMPOSE_PROJECT_NAME=algaguard-development
ECR_REGISTRY=$registry_host/$project/algaguard
GCP_PROJECT=$project
ALGAGUARD_INFRASTRUCTURE_SHA=$infra_sha
ALGAGUARD_DOMAIN=algaguard.bosilu.dev
PUBLIC_WEB_URL=https://algaguard.bosilu.dev
PUBLIC_API_URL=https://api.algaguard.bosilu.dev
PUBLIC_WSS_URL=wss://realtime.algaguard.bosilu.dev/realtime
PUBLIC_KEYCLOAK_URL=https://auth.algaguard.bosilu.dev
PUBLIC_MQTT_HOST=mqtt.algaguard.bosilu.dev
PUBLIC_MQTT_PORT=8883
DEVICE_MQTT_BIND_ADDRESS=0.0.0.0
PUBLIC_OTA_BASE_URL=https://api.algaguard.bosilu.dev
PUBLIC_TLS_HOSTS=algaguard.bosilu.dev
POSTGRES_DB=algaguard
POSTGRES_USER=algaguard
KEYCLOAK_ADMIN=algaguard-development-admin
MINIO_ROOT_USER=algaguard-development
GRAFANA_ADMIN_USER=algaguard-development-admin
ALGAGUARD_RUNTIME_UID=1000
ALGAGUARD_RUNTIME_GID=1000
HTTP_BODY_LIMIT=256kb
DEVICE_CERTIFICATE_VALIDITY_DAYS=90
DEVICE_BOOTSTRAP_TTL_SECONDS=600
DEVICE_BOOTSTRAP_MAX_ATTEMPTS=5
DEVICE_ROTATION_OVERLAP_SECONDS=300
DEVICE_BROKER_AUTH_CACHE_SECONDS=300
DEVICE_REVOCATION_EFFECTIVE_SECONDS=5
MQTT_MAX_PACKET_BYTES=262144
MQTT_MAX_SAMPLES_PER_BATCH=120
MQTT_QOS1_INFLIGHT=32
MQTT_KEEPALIVE_SECONDS=60
MQTT_SESSION_EXPIRY_SECONDS=3600
MQTT_RECONNECT_DELAY_MS=2000
MQTT_MAX_MESSAGES_PER_SECOND=200
OTA_HTTP_BODY_LIMIT_BYTES=262144
OTA_ASSIGNMENT_TTL_SECONDS=900
OTA_DOWNLOAD_URL_TTL_SECONDS=300
REALTIME_HTTP_BODY_LIMIT_BYTES=32768
WS_MAX_MESSAGE_BYTES=262144
WS_MAX_SUBSCRIPTIONS=50
WS_OUTBOUND_QUEUE_MAX=100
WS_CONNECTIONS_PER_MINUTE=20
WS_MESSAGES_PER_MINUTE=120
WS_HEARTBEAT_MS=30000
WS_IDLE_TIMEOUT_MS=90000
WS_BACKPRESSURE_BYTES=524288
WS_PREAUTH_BUFFER_MESSAGES=50
NGINX_CONFIG_PATH=./nginx/nginx.cloud.conf
NGINX_TLS_ROOT=/etc/letsencrypt
NGINX_HTTP_BIND_ADDRESS=0.0.0.0
NGINX_HTTP_PORT=80
NGINX_HTTPS_BIND_ADDRESS=0.0.0.0
NGINX_HTTPS_PORT=443
CERTBOT_WEBROOT=/opt/algaguard/runtime/certbot-webroot
EOF

# Ship the committed files with LF endings: a Windows checkout (core.autocrlf)
# has CRLF shell scripts, which fail on the Linux VM. This also makes the
# release exactly $infra_sha, never uncommitted local edits.
git -c core.autocrlf=false archive --format=tar HEAD \
  compose.yaml compose.application.yaml compose.cloud.yaml package.json \
  database emqx keycloak nginx observability scripts | tar -x -C "$work"
if grep -rlI $'\r' "$work" >/dev/null; then
  echo "CRLF line endings in the release bundle" >&2
  exit 1
fi
tar -czf "$work.tgz" -C "$work" .
trap 'rm -rf "$work" "$work.tgz"' EXIT

release="/opt/algaguard/releases/$infra_sha"
"$gcloud" compute scp "$work.tgz" "$instance:/tmp/algaguard-release.tgz" \
  --project "$project" --zone "$zone" --tunnel-through-iap --strict-host-key-checking=no --quiet
"$gcloud" compute ssh "$instance" --project "$project" --zone "$zone" \
  --tunnel-through-iap --strict-host-key-checking=no --quiet --command "set -eu
sudo install -d -m 0755 $release
sudo tar -xzf /tmp/algaguard-release.tgz -C $release
sudo chmod 0755 $release/scripts/*.sh
sudo GCP_PROJECT=$project GCP_REGISTRY_HOST=$registry_host ALGAGUARD_DOMAIN=algaguard.bosilu.dev $release/scripts/deploy-gcp.sh $release
rm -f /tmp/algaguard-release.tgz"
