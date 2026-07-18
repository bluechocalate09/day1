#!/usr/bin/env bash
set -Eeuo pipefail

readonly STATIC_DIR="/opt/daily-seal/static"
readonly REGISTRATION_CONF="/etc/systemd/system/daily-seal.service.d/registration.conf"
readonly RELEASE_DIR="/tmp/daily-seal-release-auth-ui-20260717T055634Z-019f6b89"
readonly BACKUP_DIR="/var/backups/daily-seal/20260717T055634Z-auth-ui-019f6b89"

check_health() {
  local expected="$1"
  curl -fsS http://127.0.0.1:8766/api/session 2>/dev/null \
    | python3 -c 'import json, sys; expected = sys.argv[1] == "1"; data = json.load(sys.stdin); assert data.get("ok") is True and data.get("registrationOpen") is expected' "$expected" 2>/dev/null
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
  if test -f "$BACKUP_DIR/registration.conf"; then
    install -D -o root -g root -m 0644 "$BACKUP_DIR/registration.conf" "$REGISTRATION_CONF" || restore_ok=0
  else
    rm -f -- "$REGISTRATION_CONF" || restore_ok=0
  fi
  systemctl daemon-reload || restore_ok=0
  systemctl start daily-seal || restore_ok=0
  systemctl is-active --quiet daily-seal || restore_ok=0
  old_registration="$(cat "$BACKUP_DIR/old-registration-open" 2>/dev/null || printf '0')"
  check_health "$old_registration" || restore_ok=0
  nginx -t || restore_ok=0
  if test "$restore_ok" -eq 1; then
    echo "AUTH_UI_DEPLOY_ROLLED_BACK"
  else
    echo "AUTH_UI_ROLLBACK_FAILED backup=$BACKUP_DIR" >&2
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
test -f "$RELEASE_DIR/registration.conf"
grep -qx 'Environment=DAILY_SEAL_REGISTRATION_ENABLED=1' "$RELEASE_DIR/registration.conf"
getent passwd dailyseal >/dev/null
getent group dailyseal >/dev/null
systemctl is-active --quiet daily-seal
check_health 0
nginx -t

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
cp -a "$STATIC_DIR" "$BACKUP_DIR/static"
if test -f "$REGISTRATION_CONF"; then
  cp -a "$REGISTRATION_CONF" "$BACKUP_DIR/registration.conf"
fi
printf '0\n' > "$BACKUP_DIR/old-registration-open"

trap rollback ERR
systemctl stop daily-seal
install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/index.html" "$STATIC_DIR/index.html"
install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/app.css" "$STATIC_DIR/app.css"
install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/app.js" "$STATIC_DIR/app.js"
install -D -o root -g root -m 0644 "$RELEASE_DIR/registration.conf" "$REGISTRATION_CONF"
systemctl daemon-reload
systemctl start daily-seal

healthy=0
for _attempt in $(seq 1 30); do
  if check_health 1; then
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
echo "AUTH_UI_DEPLOY_OK"
echo "BACKUP=$BACKUP_DIR"
sha256sum "$STATIC_DIR/index.html" "$STATIC_DIR/app.css" "$STATIC_DIR/app.js"
cat "$REGISTRATION_CONF"
