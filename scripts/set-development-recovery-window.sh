#!/usr/bin/env bash
set -euo pipefail

action=${1:-}
case "$action" in
  enable-reissue|enable-handoff|disable-all|status) ;;
  *)
    echo "usage: set-development-recovery-window.sh {enable-reissue|enable-handoff|disable-all|status}" >&2
    exit 2
    ;;
esac

release=$(readlink -f /opt/algaguard/current)
case "$release" in
  /opt/algaguard/releases/*) ;;
  *) echo "current release is unavailable" >&2; exit 3 ;;
esac

env_file="$release/.env"
test -f "$env_file"
test "$(stat -c '%a' "$env_file")" = 600

compose=(docker compose --env-file "$env_file"
  -f "$release/compose.yaml"
  -f "$release/compose.application.yaml"
  -f "$release/compose.cloud.yaml")

report_status() {
  local container environment reissue handoff
  container=$("${compose[@]}" ps -q device-service)
  test -n "$container"
  environment=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container")
  reissue=$(printf '%s\n' "$environment" |
    awk -F= '$1=="ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE"{print $2}')
  handoff=$(printf '%s\n' "$environment" |
    awk -F= '$1=="ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF"{print $2}')
  test "$reissue" = 1 && echo "bootstrap_reissue_enabled=true" ||
    echo "bootstrap_reissue_enabled=false"
  test "$handoff" = 1 && echo "physical_handoff_enabled=true" ||
    echo "physical_handoff_enabled=false"
}

if [ "$action" = status ]; then
  report_status
  exit 0
fi

exec 9>/opt/algaguard/runtime/.recovery-window.lock
flock -x 9

temporary=$(mktemp /opt/algaguard/runtime/.env.recovery.XXXXXX)
trap 'rm -f "$temporary"' EXIT
chmod 0600 "$temporary"
awk -F= '
  $1 != "ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE" &&
  $1 != "ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF" &&
  $1 != "PHYSICAL_SESSION_HANDOFF_WRAPPING_KEY"
' "$env_file" >"$temporary"

case "$action" in
  enable-reissue)
    printf '%s\n' \
      'ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE=1' \
      'ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF=0' >>"$temporary"
    ;;
  enable-handoff)
    wrapping_key=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\r\n')
    test "$(printf '%s' "$wrapping_key" | wc -c)" -ge 43
    printf '%s\n' \
      'ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE=0' \
      'ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF=1' \
      "PHYSICAL_SESSION_HANDOFF_WRAPPING_KEY=$wrapping_key" >>"$temporary"
    unset wrapping_key
    ;;
  disable-all)
    printf '%s\n' \
      'ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE=0' \
      'ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF=0' >>"$temporary"
    ;;
esac

mv -f "$temporary" "$env_file"
trap - EXIT
chmod 0600 "$env_file"
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --force-recreate --wait --wait-timeout 180 device-service
report_status
