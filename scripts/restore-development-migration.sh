#!/usr/bin/env bash
set -euo pipefail

test "$(id -u)" -eq 0
object=${1:?migration backup object key required}
case "$object" in
  migration/*/system-state.tgz) ;;
  *) echo 'Unsafe migration object key.' >&2; exit 2 ;;
esac

bucket=${ALGAGUARD_BACKUP_BUCKET:-algaguard-dev-backups-862620869833-ap-southeast-1}
archive=$(mktemp /opt/algaguard/runtime/migration-restore.XXXXXX.tgz)
checksum=$(mktemp /opt/algaguard/runtime/migration-restore.XXXXXX.sha256)
rollback=$(mktemp -d /opt/algaguard/runtime/migration-rollback.XXXXXX)
restored=false

cleanup() {
  rm -f "$archive" "$checksum"
  if "$restored"; then
    rm -rf "$rollback"
  fi
}
trap cleanup EXIT

aws s3 cp --only-show-errors "s3://$bucket/$object" "$archive"
aws s3 cp --only-show-errors "s3://$bucket/$object.sha256" "$checksum"
expected=$(awk 'NR == 1 {print $1}' "$checksum")
printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status

systemctl stop algaguard-development.service || true
systemctl stop docker

install -d -m 0700 "$rollback/docker" "$rollback/runtime" "$rollback/etc"
test -d /var/lib/docker/volumes &&
  mv /var/lib/docker/volumes "$rollback/docker/volumes"
test -d /opt/algaguard/runtime/pki &&
  mv /opt/algaguard/runtime/pki "$rollback/runtime/pki"
test -f /opt/algaguard/runtime/.pki-ready &&
  mv /opt/algaguard/runtime/.pki-ready "$rollback/runtime/.pki-ready"
test -d /etc/letsencrypt &&
  mv /etc/letsencrypt "$rollback/etc/letsencrypt"

rollback_state() {
  rm -rf /var/lib/docker/volumes /opt/algaguard/runtime/pki \
    /opt/algaguard/runtime/.pki-ready /etc/letsencrypt
  test ! -d "$rollback/docker/volumes" ||
    mv "$rollback/docker/volumes" /var/lib/docker/volumes
  test ! -d "$rollback/runtime/pki" ||
    mv "$rollback/runtime/pki" /opt/algaguard/runtime/pki
  test ! -f "$rollback/runtime/.pki-ready" ||
    mv "$rollback/runtime/.pki-ready" /opt/algaguard/runtime/.pki-ready
  test ! -d "$rollback/etc/letsencrypt" ||
    mv "$rollback/etc/letsencrypt" /etc/letsencrypt
}

if ! tar --acls --xattrs --numeric-owner -C / -xzf "$archive"; then
  rollback_state
  systemctl start docker
  systemctl start algaguard-development.service
  exit 3
fi

systemctl start docker
if ! systemctl start algaguard-development.service; then
  systemctl stop docker
  rollback_state
  systemctl start docker
  systemctl start algaguard-development.service
  exit 4
fi

restored=true
echo 'Encrypted migration state restored and development service started.'
