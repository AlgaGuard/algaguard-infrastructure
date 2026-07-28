#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:?release directory required}
region=${AWS_REGION:-ap-southeast-1}
account_id=${AWS_ACCOUNT_ID:?AWS account ID required}
domain=${ALGAGUARD_DOMAIN:-algaguard.bosilu.dev}
compose_version=v5.1.4
compose_sha256=33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4
compose_plugin=/usr/local/lib/docker/cli-plugins/docker-compose

case "$release_dir" in
  /opt/algaguard/releases/*) ;;
  *) echo 'Unsafe release directory.' >&2; exit 2 ;;
esac
test -f "$release_dir/release.env"

install_compose() {
  if docker compose version >/dev/null 2>&1; then return; fi
  install -d -m 0755 "$(dirname "$compose_plugin")"
  curl --fail --location --silent --show-error \
    "https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-x86_64" \
    --output "${compose_plugin}.tmp"
  echo "$compose_sha256  ${compose_plugin}.tmp" | sha256sum --check
  install -m 0755 "${compose_plugin}.tmp" "$compose_plugin"
  rm -f "${compose_plugin}.tmp"
  docker compose version >/dev/null
}

append_parameter() {
  local env_name=$1 parameter_name=$2 temporary
  temporary=$(mktemp /opt/algaguard/.parameter.XXXXXX)
  chmod 0600 "$temporary"
  aws ssm get-parameter --region "$region" --with-decryption \
    --name "/algaguard/development/$parameter_name" \
    --query Parameter.Value --output text >"$temporary"
  printf '%s=' "$env_name" >>"$runtime_env"
  tr -d '\r\n' <"$temporary" >>"$runtime_env"
  printf '\n' >>"$runtime_env"
  rm -f "$temporary"
}

install_compose
install -d -m 0700 /opt/algaguard/runtime /opt/algaguard/bin
install -d -m 0755 /opt/algaguard/runtime/certbot-webroot
runtime_env=$(mktemp /opt/algaguard/runtime/.env.XXXXXX)
chmod 0600 "$runtime_env"
cat "$release_dir/release.env" >"$runtime_env"

append_parameter POSTGRES_PASSWORD postgres-password
append_parameter KEYCLOAK_ADMIN_PASSWORD keycloak-admin-password
append_parameter MINIO_ROOT_PASSWORD minio-root-password
append_parameter GRAFANA_ADMIN_PASSWORD grafana-admin-password
append_parameter ALGAGUARD_ACCESS_SERVICE_SECRET access-service-secret
append_parameter ALGAGUARD_DEVICE_SERVICE_SECRET device-service-secret
append_parameter ALGAGUARD_MQTT_INGESTION_SERVICE_SECRET mqtt-ingestion-service-secret
append_parameter ALGAGUARD_TELEMETRY_SERVICE_SECRET telemetry-service-secret
append_parameter ALGAGUARD_REALTIME_SERVICE_SECRET realtime-service-secret
append_parameter ALGAGUARD_PROFILE_SERVICE_SECRET profile-service-secret
append_parameter ALGAGUARD_COMMAND_SERVICE_SECRET command-service-secret
append_parameter ALGAGUARD_OTA_SERVICE_SECRET ota-service-secret
append_parameter ALGAGUARD_FIRMWARE_RELEASE_SECRET firmware-release-secret
append_parameter BROKER_DEVICE_AUTH_TOKEN broker-device-auth-token
append_parameter EMQX_NODE_COOKIE emqx-node-cookie
mv "$runtime_env" "$release_dir/.env"
chmod 0600 "$release_dir/.env"

if [ ! -f /opt/algaguard/runtime/.pki-ready ]; then
  docker run --rm --network none \
    -v "$release_dir:/workspace" \
    -v /opt/algaguard/runtime/pki:/workspace/.local/pki \
    -w /workspace node:22-bookworm node scripts/pki.mjs init
  docker run --rm --network none \
    -v "$release_dir:/workspace" \
    -v /opt/algaguard/runtime/pki:/workspace/.local/pki \
    -w /workspace node:22-bookworm node scripts/pki.mjs server-cert
  for service in algaguard-mqtt-ingestion-service algaguard-command-service algaguard-ota-service; do
    docker run --rm --network none \
      -v "$release_dir:/workspace" \
      -v /opt/algaguard/runtime/pki:/workspace/.local/pki \
      -w /workspace node:22-bookworm node scripts/pki.mjs service-cert "$service"
  done
  docker run --rm --network none \
    -v "$release_dir:/workspace" \
    -v /opt/algaguard/runtime/pki:/workspace/.local/pki \
    -w /workspace node:22-bookworm node scripts/pki.mjs ota-signing-key
  touch /opt/algaguard/runtime/.pki-ready
fi
rm -rf "$release_dir/.local/pki"
ln -s /opt/algaguard/runtime/pki "$release_dir/.local/pki"

if [ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
  for host in "$domain" "api.$domain" "auth.$domain" "realtime.$domain"; do
    getent ahostsv4 "$host" | awk '{print $1}' | grep -qx '52.74.126.184' || {
      echo "DNS is not ready for $host." >&2
      exit 3
    }
  done
  docker run --rm --name algaguard-certbot-bootstrap -p 80:80 \
    -v /etc/letsencrypt:/etc/letsencrypt \
    certbot/certbot:v4.1.1 certonly --standalone --non-interactive \
    --agree-tos --register-unsafely-without-email \
    -d "$domain" -d "api.$domain" -d "auth.$domain" -d "realtime.$domain"
fi

aws ecr get-login-password --region "$region" |
  docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${region}.amazonaws.com" >/dev/null

compose=(docker compose --env-file "$release_dir/.env" \
  -f "$release_dir/compose.yaml" \
  -f "$release_dir/compose.application.yaml" \
  -f "$release_dir/compose.cloud.yaml")
"${compose[@]}" config --quiet
"${compose[@]}" pull

previous=''
if [ -L /opt/algaguard/current ]; then previous=$(readlink -f /opt/algaguard/current); fi
ln -sfn "$release_dir" /opt/algaguard/current.next
mv -Tf /opt/algaguard/current.next /opt/algaguard/current

if ! "${compose[@]}" up -d --no-build --remove-orphans --wait --wait-timeout 600; then
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    ln -sfn "$previous" /opt/algaguard/current
    docker compose --env-file "$previous/.env" -f "$previous/compose.yaml" \
      -f "$previous/compose.application.yaml" -f "$previous/compose.cloud.yaml" \
      up -d --no-build --remove-orphans --wait --wait-timeout 600
  fi
  exit 4
fi

curl --fail --silent --show-error --max-time 20 "https://$domain/health" >/dev/null
curl --fail --silent --show-error --max-time 20 "https://api.$domain/health" >/dev/null
curl --fail --silent --show-error --max-time 20 "https://auth.$domain/realms/algaguard/.well-known/openid-configuration" >/dev/null

cat >/etc/systemd/system/algaguard-development.service <<'UNIT'
[Unit]
Description=AlgaGuard development demo stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/algaguard/bin/start-development
ExecStop=/opt/algaguard/bin/stop-development
[Install]
WantedBy=multi-user.target
UNIT

install -m 0755 "$release_dir/scripts/start-development.sh" /opt/algaguard/bin/start-development
install -m 0755 "$release_dir/scripts/stop-development.sh" /opt/algaguard/bin/stop-development
install -m 0755 "$release_dir/scripts/backup-development.sh" /opt/algaguard/bin/backup-development
install -m 0755 "$release_dir/scripts/verify-backup-restore.sh" /opt/algaguard/bin/verify-backup-restore
install -m 0755 "$release_dir/scripts/reload-nginx.sh" /opt/algaguard/bin/reload-nginx
cat >/etc/systemd/system/algaguard-backup.service <<'UNIT'
[Unit]
Description=AlgaGuard encrypted development database backup
After=algaguard-development.service
[Service]
Type=oneshot
ExecStart=/opt/algaguard/bin/backup-development
UNIT
cat >/etc/systemd/system/algaguard-backup.timer <<'UNIT'
[Unit]
Description=Daily AlgaGuard development backup
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
UNIT
cat >/etc/systemd/system/algaguard-certificate-renew.service <<UNIT
[Unit]
Description=Renew AlgaGuard public TLS certificate
[Service]
Type=oneshot
ExecStart=/usr/bin/docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /opt/algaguard/runtime/certbot-webroot:/var/www/certbot certbot/certbot:v4.1.1 renew --webroot -w /var/www/certbot --non-interactive
ExecStartPost=/opt/algaguard/bin/reload-nginx
UNIT
cat >/etc/systemd/system/algaguard-certificate-renew.timer <<'UNIT'
[Unit]
Description=Twice-daily AlgaGuard certificate renewal check
[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=30m
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable algaguard-development.service >/dev/null
systemctl enable --now algaguard-backup.timer algaguard-certificate-renew.timer >/dev/null
echo 'AlgaGuard immutable development deployment is healthy.'
