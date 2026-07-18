#!/usr/bin/env bash
set -Eeuo pipefail

readonly SOURCE="/tmp/daily-seal-registration-019f6b89.conf"
readonly DROPIN_DIR="/etc/systemd/system/daily-seal.service.d"
readonly TARGET="$DROPIN_DIR/registration.conf"
readonly BACKUP_DIR="/var/backups/daily-seal/20260717T031000Z-focus-019f6b89"
had_existing=0

rollback() {
  trap - ERR
  set +e
  if test "$had_existing" -eq 1; then
    cp -a "$BACKUP_DIR/registration.conf.before" "$TARGET"
  else
    rm -f -- "$TARGET"
  fi
  systemctl daemon-reload
  systemctl restart daily-seal
  echo "REGISTRATION_CONFIG_ROLLED_BACK" >&2
  exit 1
}

test "$(id -u)" -eq 0
test -f "$SOURCE"
test -d "$BACKUP_DIR"
systemctl cat daily-seal >"$BACKUP_DIR/daily-seal.service.before-registration.txt"
install -d -m 0755 "$DROPIN_DIR"
if test -e "$TARGET"; then
  cp -a "$TARGET" "$BACKUP_DIR/registration.conf.before"
  had_existing=1
fi

trap rollback ERR
install -o root -g root -m 0644 "$SOURCE" "$TARGET"
systemctl daemon-reload
systemctl restart daily-seal

healthy=0
for _attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8766/api/session | grep -q '"registrationOpen":false'; then
    healthy=1
    break
  fi
  sleep 0.5
done
test "$healthy" -eq 1
systemctl is-active --quiet daily-seal

trap - ERR
rm -f -- "$SOURCE"
echo "REGISTRATION_DISABLED"
