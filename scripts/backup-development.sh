#!/usr/bin/env bash
set -euo pipefail
release=$(readlink -f /opt/algaguard/current)
bucket=${ALGAGUARD_BACKUP_BUCKET:-algaguard-dev-backups-862620869833-ap-southeast-1}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp /opt/algaguard/runtime/postgres.XXXXXX.dump)
trap 'rm -f "$temporary"' EXIT
docker compose --env-file "$release/.env" -f "$release/compose.yaml" \
  exec -T timescaledb pg_dump -Fc -U algaguard algaguard >"$temporary"
aws s3 cp --only-show-errors "$temporary" "s3://$bucket/postgresql/$timestamp.dump"
echo 'Encrypted development database backup uploaded.'
