#!/usr/bin/env bash
set -euo pipefail
release=$(readlink -f /opt/algaguard/current)
exec docker compose --env-file "$release/.env" -f "$release/compose.yaml" \
  -f "$release/compose.application.yaml" -f "$release/compose.cloud.yaml" stop
