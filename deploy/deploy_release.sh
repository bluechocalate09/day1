#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/daily-seal"
readonly DATA_DIR="/var/lib/daily-seal"
readonly RELEASE_DIR="/tmp/daily-seal-release-focus-019f6b89"
readonly BACKUP_DIR="/var/backups/daily-seal/20260717T031000Z-focus-019f6b89"

check_health() {
  curl -fsS http://127.0.0.1:8766/api/session \
    | python3 -c 'import json, sys; data = json.load(sys.stdin); assert data.get("ok") is True and "authenticated" in data and data.get("csrfToken")'
}

rollback() {
  trap - ERR
  set +e
  restore_ok=1
  systemctl stop daily-seal || restore_ok=0
  if test -e "$APP_DIR"; then
    mv "$APP_DIR" "$BACKUP_DIR/failed-opt-daily-seal" || restore_ok=0
  fi
  if test -e "$DATA_DIR"; then
    mv "$DATA_DIR" "$BACKUP_DIR/failed-var-lib-daily-seal" || restore_ok=0
  fi
  cp -a "$BACKUP_DIR/opt-daily-seal" "$APP_DIR" || restore_ok=0
  cp -a "$BACKUP_DIR/var-lib-daily-seal" "$DATA_DIR" || restore_ok=0
  chown -R dailyseal:dailyseal "$APP_DIR" "$DATA_DIR" || restore_ok=0
  systemctl start daily-seal || restore_ok=0
  systemctl is-active --quiet daily-seal || restore_ok=0
  check_health || restore_ok=0
  if test "$restore_ok" -eq 1; then
    echo "DEPLOY_ROLLED_BACK"
  else
    echo "ROLLBACK_FAILED backup=$BACKUP_DIR" >&2
  fi
  exit 1
}

resume_old_service() {
  trap - ERR
  set +e
  if systemctl start daily-seal && systemctl is-active --quiet daily-seal && check_health; then
    echo "DEPLOY_PREPARE_FAILED"
  else
    echo "DEPLOY_PREPARE_RECOVERY_FAILED" >&2
  fi
  exit 1
}

test "$(id -u)" -eq 0
test ! -e "$BACKUP_DIR"
test -d "$APP_DIR/static"
test -d "$DATA_DIR"
getent passwd dailyseal >/dev/null
getent group dailyseal >/dev/null
systemctl is-active --quiet daily-seal
nginx -t
test -f "$RELEASE_DIR/app.py"
test -f "$RELEASE_DIR/static/index.html"
test -f "$RELEASE_DIR/static/app.css"
test -f "$RELEASE_DIR/static/app.js"

python3 -m py_compile "$RELEASE_DIR/app.py"
test "$(df --output=avail -k /var/backups | tail -n 1)" -gt 102400
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
cp -a "$APP_DIR" "$BACKUP_DIR/opt-daily-seal"

trap resume_old_service ERR
systemctl stop daily-seal
cp -a "$DATA_DIR" "$BACKUP_DIR/var-lib-daily-seal"
trap rollback ERR

install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/app.py" "$APP_DIR/app.py"
install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/static/index.html" "$APP_DIR/static/index.html"
install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/static/app.css" "$APP_DIR/static/app.css"
install -o dailyseal -g dailyseal -m 0640 "$RELEASE_DIR/static/app.js" "$APP_DIR/static/app.js"

systemctl start daily-seal
systemctl is-active --quiet daily-seal

healthy=0
for _attempt in $(seq 1 30); do
  if check_health; then
    healthy=1
    break
  fi
  sleep 0.5
done
test "$healthy" -eq 1
python3 -c 'import sqlite3; db = sqlite3.connect("/var/lib/daily-seal/daily-seal.db"); columns = {row[1] for row in db.execute("PRAGMA table_info(daily_stats)")}; assert "distractions" in columns'
nginx -t

trap - ERR
echo "DEPLOY_OK"
echo "BACKUP=$BACKUP_DIR"
sha256sum "$APP_DIR/app.py" "$APP_DIR/static/index.html" "$APP_DIR/static/app.css" "$APP_DIR/static/app.js"
systemctl is-active daily-seal
