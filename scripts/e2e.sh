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

compose up -d --build --wait
npm ci
npm run test:e2e
