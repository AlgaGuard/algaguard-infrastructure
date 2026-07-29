#!/usr/bin/env bash
set -euo pipefail

test "$(id -u)" -eq 0
bucket=${ALGAGUARD_BACKUP_BUCKET:-algaguard-dev-backups-862620869833-ap-southeast-1}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive=$(mktemp /opt/algaguard/runtime/migration.XXXXXX.tgz)
checksum="${archive}.sha256"
object="migration/$timestamp/system-state.tgz"
service_was_active=false
docker_was_active=false

cleanup() {
  rm -f "$archive" "$checksum"
  if "$docker_was_active" && ! systemctl is-active --quiet docker; then
    systemctl start docker
  fi
  if "$service_was_active" &&
    ! systemctl is-active --quiet algaguard-development.service; then
    systemctl start algaguard-development.service
  fi
}
trap cleanup EXIT

systemctl is-active --quiet algaguard-development.service &&
  service_was_active=true
systemctl is-active --quiet docker && docker_was_active=true

if "$service_was_active"; then
  systemctl stop algaguard-development.service
fi
if "$docker_was_active"; then
  systemctl stop docker
fi

paths=(var/lib/docker/volumes)
test -d /var/lib/docker/volumes
test -d /opt/algaguard/runtime/pki && paths+=(opt/algaguard/runtime/pki)
test -f /opt/algaguard/runtime/.pki-ready &&
  paths+=(opt/algaguard/runtime/.pki-ready)
test -d /etc/letsencrypt && paths+=(etc/letsencrypt)

tar --acls --xattrs --numeric-owner -C / -czf "$archive" "${paths[@]}"
sha256sum "$archive" | awk '{print $1 "  system-state.tgz"}' >"$checksum"

if "$docker_was_active"; then
  systemctl start docker
fi
if "$service_was_active"; then
  systemctl start algaguard-development.service
fi

aws s3 cp --only-show-errors --sse AES256 "$archive" "s3://$bucket/$object"
aws s3 cp --only-show-errors --sse AES256 "$checksum" \
  "s3://$bucket/$object.sha256"
printf 'Encrypted migration backup uploaded: %s\n' "$object"
