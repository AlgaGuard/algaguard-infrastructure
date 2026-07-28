#!/usr/bin/env bash
set -euo pipefail
release=$(readlink -f /opt/algaguard/current)
bucket=${ALGAGUARD_BACKUP_BUCKET:-algaguard-dev-backups-862620869833-ap-southeast-1}
object=$(aws s3api list-objects-v2 --bucket "$bucket" --prefix postgresql/ \
  --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
test "$object" != None
temporary=$(mktemp /opt/algaguard/runtime/restore.XXXXXX.dump)
database=algaguard_restore_check
cleanup() {
  rm -f "$temporary"
  docker compose --env-file "$release/.env" -f "$release/compose.yaml" \
    exec -T timescaledb dropdb --if-exists -U algaguard "$database" >/dev/null 2>&1 || true
}
trap cleanup EXIT
aws s3 cp --only-show-errors "s3://$bucket/$object" "$temporary"
docker compose --env-file "$release/.env" -f "$release/compose.yaml" \
  exec -T timescaledb createdb -U algaguard "$database"
docker compose --env-file "$release/.env" -f "$release/compose.yaml" \
  exec -T timescaledb pg_restore -U algaguard -d "$database" --no-owner <"$temporary"
echo 'Synthetic development restore check passed.'
