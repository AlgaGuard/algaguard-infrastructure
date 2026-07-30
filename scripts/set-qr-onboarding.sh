#!/usr/bin/env bash
set -euo pipefail

action=${1:-}
case "$action" in enable|disable|status) ;; *) echo 'usage: set-qr-onboarding.sh {enable|disable|status}' >&2; exit 2 ;; esac
window_seconds=${2:-900}
if [ "$action" = enable ]; then
  case "$window_seconds" in 600|900) ;; *) echo 'enable window must be 600 or 900 seconds' >&2; exit 2 ;; esac
fi
release=$(readlink -f /opt/algaguard/current)
case "$release" in /opt/algaguard/releases/*) ;; *) exit 3 ;; esac
env_file="$release/.env"
test -f "$env_file"
test "$(stat -c '%a' "$env_file")" = 600
compose=(docker compose --env-file "$env_file" -f "$release/compose.yaml"
  -f "$release/compose.application.yaml" -f "$release/compose.cloud.yaml")

status() {
  enabled=$("${compose[@]}" exec -T device-service sh -c \
    'printf "%s" "${ALGAGUARD_ENABLE_QR_ONBOARDING:-0}"' 2>/dev/null || printf 0)
  if [ "$enabled" = 1 ]; then echo QR_ONBOARDING_ENABLED; else echo QR_ONBOARDING_DISABLED; fi
}

exec 9>/opt/algaguard/runtime/.qr-onboarding.lock
flock -x 9
if [ "$action" = status ]; then status; exit 0; fi

systemctl stop algaguard-qr-onboarding-expiry.timer >/dev/null 2>&1 || true
systemctl reset-failed algaguard-qr-onboarding-expiry.timer >/dev/null 2>&1 || true

temporary=$(mktemp /opt/algaguard/runtime/.env.qr.XXXXXX)
original=$(mktemp /opt/algaguard/runtime/.env.qr-original.XXXXXX)
chmod 0600 "$temporary" "$original"
cp "$env_file" "$original"
trap 'rm -f "$temporary" "$original"' EXIT
awk -F= '$1 != "ALGAGUARD_ENABLE_QR_ONBOARDING" && $1 != "QR_ONBOARDING_SIGNING_PRIVATE_KEY_PKCS8"' \
  "$env_file" >"$temporary"

if [ "$action" = enable ]; then
  secret=$(mktemp /opt/algaguard/runtime/.qr-key.XXXXXX)
  chmod 0600 "$secret"
  trap 'rm -f "$temporary" "$original" "$secret"' EXIT
  aws ssm get-parameter --region "${AWS_REGION:-ap-southeast-1}" --with-decryption \
    --name /algaguard/development/qr-onboarding-signing-private-key-pkcs8 \
    --query Parameter.Value --output text >"$secret"
  test "$(tr -d '\r\n' <"$secret" | wc -c)" -ge 120
  printf 'ALGAGUARD_ENABLE_QR_ONBOARDING=1\nQR_ONBOARDING_SIGNING_PRIVATE_KEY_PKCS8=' >>"$temporary"
  tr -d '\r\n' <"$secret" >>"$temporary"
  printf '\n' >>"$temporary"
  rm -f "$secret"
else
  printf 'ALGAGUARD_ENABLE_QR_ONBOARDING=0\n' >>"$temporary"
fi

mv "$temporary" "$env_file"
chmod 0600 "$env_file"
if ! "${compose[@]}" config --quiet ||
   ! "${compose[@]}" up -d --no-deps --no-build device-service; then
  mv "$original" "$env_file"
  chmod 0600 "$env_file"
  "${compose[@]}" up -d --no-deps --no-build device-service >/dev/null
  echo QR_ONBOARDING_FAILED
  exit 4
fi
for _ in $(seq 1 60); do
  if "${compose[@]}" exec -T device-service wget --spider -q http://localhost:3000/health/ready; then break; fi
  sleep 2
done
"${compose[@]}" exec -T device-service wget --spider -q http://localhost:3000/health/ready
if [ "$action" = enable ]; then
  test "$(status)" = QR_ONBOARDING_ENABLED
  systemd-run --quiet --unit=algaguard-qr-onboarding-expiry \
    --on-active="${window_seconds}s" \
    /opt/algaguard/current/scripts/set-qr-onboarding.sh disable
  echo QR_ONBOARDING_ENABLED
else
  test "$(status)" = QR_ONBOARDING_DISABLED
  echo QR_ONBOARDING_DISABLED
fi
