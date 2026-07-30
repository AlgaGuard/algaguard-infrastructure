#!/usr/bin/env bash
set -euo pipefail

action=${1:-}
case "$action" in
  start|stop|status) ;;
  *) echo "usage: set-demo-telemetry-simulator.sh {start|stop|status}" >&2; exit 2 ;;
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
  -f "$release/compose.cloud.yaml"
  --profile demo-simulator)

status() {
  container=$("${compose[@]}" ps -aq demo-telemetry-simulator)
  if [ -z "$container" ]; then
    echo DEMO_SIMULATOR_DISABLED
    return
  fi
  running=$(docker inspect --format '{{.State.Running}}' "$container")
  if [ "$running" = true ]; then
    enabled=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
      awk -F= '$1=="ALGAGUARD_ENABLE_DEMO_TELEMETRY_SIMULATOR"{print $2}')
    test "$enabled" = 1
    echo DEMO_SIMULATOR_RUNNING
  else
    echo DEMO_SIMULATOR_STOPPED
  fi
}

exec 9>/opt/algaguard/runtime/.demo-simulator.lock
flock -x 9

case "$action" in
  start)
    export ALGAGUARD_ENABLE_DEMO_TELEMETRY_SIMULATOR=1
    "${compose[@]}" config --quiet
    "${compose[@]}" up -d --no-deps --no-build demo-telemetry-simulator
    for _ in $(seq 1 30); do
      state=$(status)
      [ "$state" = DEMO_SIMULATOR_RUNNING ] && break
      sleep 1
    done
    [ "$(status)" = DEMO_SIMULATOR_RUNNING ]
    echo DEMO_SIMULATOR_RUNNING
    ;;
  stop)
    "${compose[@]}" rm -f -s demo-telemetry-simulator >/dev/null 2>&1 || true
    echo DEMO_SIMULATOR_STOPPED
    ;;
  status)
    status
    ;;
esac
