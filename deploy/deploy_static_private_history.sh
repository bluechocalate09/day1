#!/usr/bin/env bash
set -Eeuo pipefail

readonly STATIC_DIR="/opt/daily-seal/static"
readonly RELEASE_DIR="/tmp/daily-seal-release-static-private-20260717T035652Z-019f6b89"
readonly BACKUP_DIR="/var/backups/daily-seal/20260717T035652Z-static-private-019f6b89"

check_health() {
  curl -fsS http://127.0.0.1:8766/api/session 2>/dev/null \
    | python3 -c 'import json, sys; data = json.load(sys.stdin); assert data.get("ok") is True and data.get("registrationOpen") is False' 2>/dev/null
}

rollback() {
  trap - ERR
  set +e
  restore_ok=1
  systemctl stop daily-seal || restore_ok=0
  if test -e "$STATIC_DIR"; then
    mv "$STATIC_DIR" "$BACKUP_DIR/failed-static" || restore_ok=0
  fi
  cp -a "$BACKUP_DIR/static" "$STATIC_DIR" || restore_ok=0
  chown -R dailyseal:dailyseal "$STATIC_DIR" || restore_ok=0
  systemctl start daily-seal || restore_ok=0
  systemctl is-active --quiet daily-seal || restore_ok=0
  check_health || restore_ok=0
  if test "$restore_ok" -eq 1; then
    echo "STATIC_DEPLOY_ROLLED_BACK"
  else
    echo "STATIC_ROLLBACK_FAILED backup=$BACKUP_DIR" >&2
  fi
  exit 1
}

test "$(id -u)" -eq 0
test ! -e "$RELEASE_DIR/.deployed"
test ! -e "$BACKUP_DIR"
test -d "$STATIC_DIR"
test -f "$RELEASE_DIR/index.html"
test -f "$RELEASE_DIR/app.css"
test -f "$RELEASE_DIR/app.js"
getent passwd dailyseal >/dev/null
getent group dailyseal >/dev/null
systemctl is-active --quiet daily-seal
check_health
nginx -t

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
cp -a "$STATIC_DIR" "$BACKUP_DIR/static"

trap rollback ERR
systemctl stop daily-seal
install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/index.html" "$STATIC_DIR/index.html"
install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/app.css" "$STATIC_DIR/app.css"
install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/app.js" "$STATIC_DIR/app.js"
systemctl start daily-seal

healthy=0
for _attempt in $(seq 1 30); do
  if check_health; then
    healthy=1
    break
  fi
  sleep 0.5
done
test "$healthy" -eq 1
systemctl is-active --quiet daily-seal
nginx -t
touch "$RELEASE_DIR/.deployed"

trap - ERR
echo "STATIC_DEPLOY_OK"
echo "BACKUP=$BACKUP_DIR"
sha256sum "$STATIC_DIR/index.html" "$STATIC_DIR/app.css" "$STATIC_DIR/app.js"
