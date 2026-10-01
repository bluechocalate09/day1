#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_LINK="/opt/daily-seal"
readonly RELEASE_ROOT="/opt/daily-seal-releases"
readonly DATA_DIR="/var/lib/daily-seal"
readonly PUBLIC_BASE="https://day1.bluechocalate.localhost.cc"
readonly RELEASE_ID="20260818T180931Z-pom-backfill-scale"
readonly RELEASE_DIR="$RELEASE_ROOT/$RELEASE_ID"
readonly STAGE_DIR="/tmp/day1-$RELEASE_ID"
readonly BACKUP_DIR="/var/backups/daily-seal/$RELEASE_ID"

readonly APP_SHA="e4285849e346a666fffd731e3f8dc02f1bbbbb44eeb23ba904b7c63106e3768e"
readonly INDEX_SHA="e295dd70d4518d913ce7c3031a483587840ee58aa8064d3c7f907024318a1ba6"
readonly CSS_SHA="9f5b58359be14a52ec02c3ca00f513098fc75372b757079a85993e324c1c0513"
readonly JS_SHA="93e6b58fa03c1ad9983d5d3acaa3ec5cb8f998d3932b4d20584d9545659ca2ad"

OLD_RELEASE=""
DATA_BACKUP_READY=0

check_health() {
  curl -fsS http://127.0.0.1:8766/api/session \
    | python3 -c 'import json, sys; data = json.load(sys.stdin); assert data.get("ok") is True and "authenticated" in data and data.get("csrfToken")'
}

restore_previous_release() {
  trap - ERR
  set +e
  local restore_ok=1
  systemctl stop daily-seal || restore_ok=0
  if test "$DATA_BACKUP_READY" -eq 1; then
    if test -e "$DATA_DIR"; then
      mv "$DATA_DIR" "$BACKUP_DIR/failed-var-lib-daily-seal" || restore_ok=0
    fi
    cp -a "$BACKUP_DIR/var-lib-daily-seal" "$DATA_DIR" || restore_ok=0
    chown -R dailyseal:dailyseal "$DATA_DIR" || restore_ok=0
  fi
  if test -n "$OLD_RELEASE" && test -d "$OLD_RELEASE"; then
    ln -s "$OLD_RELEASE" "$APP_LINK.rollback" || restore_ok=0
    mv -Tf "$APP_LINK.rollback" "$APP_LINK" || restore_ok=0
  else
    restore_ok=0
  fi
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

test "$(id -u)" -eq 0
test -L "$APP_LINK"
OLD_RELEASE="$(readlink -f "$APP_LINK")"
test -d "$OLD_RELEASE/static"
test -d "$DATA_DIR"
test ! -e "$RELEASE_DIR"
test ! -e "$BACKUP_DIR"
test -f "$STAGE_DIR/app.py"
test -f "$STAGE_DIR/static/index.html"
test -f "$STAGE_DIR/static/app.css"
test -f "$STAGE_DIR/static/app.js"
getent passwd dailyseal >/dev/null
getent group dailyseal >/dev/null
systemctl is-active --quiet daily-seal
check_health
nginx -t
test "$(df --output=avail -k /var/backups | tail -n 1)" -gt 102400

printf '%s  %s\n' "$APP_SHA" "$STAGE_DIR/app.py" \
  | sha256sum -c -
printf '%s  %s\n' "$INDEX_SHA" "$STAGE_DIR/static/index.html" \
  | sha256sum -c -
printf '%s  %s\n' "$CSS_SHA" "$STAGE_DIR/static/app.css" \
  | sha256sum -c -
printf '%s  %s\n' "$JS_SHA" "$STAGE_DIR/static/app.js" \
  | sha256sum -c -
python3 -m py_compile "$STAGE_DIR/app.py"

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
printf '%s\n' "$OLD_RELEASE" > "$BACKUP_DIR/previous-release"
cp -aL "$APP_LINK" "$BACKUP_DIR/opt-daily-seal"

cp -a "$OLD_RELEASE" "$RELEASE_DIR"
install -o dailyseal -g dailyseal -m 0640 \
  "$STAGE_DIR/app.py" "$RELEASE_DIR/app.py"
install -o dailyseal -g dailyseal -m 0640 \
  "$STAGE_DIR/static/index.html" "$RELEASE_DIR/static/index.html"
install -o dailyseal -g dailyseal -m 0640 \
  "$STAGE_DIR/static/app.css" "$RELEASE_DIR/static/app.css"
install -o dailyseal -g dailyseal -m 0640 \
  "$STAGE_DIR/static/app.js" "$RELEASE_DIR/static/app.js"

trap restore_previous_release ERR
systemctl stop daily-seal
cp -a "$DATA_DIR" "$BACKUP_DIR/var-lib-daily-seal"
DATA_BACKUP_READY=1
ln -s "$RELEASE_DIR" "$APP_LINK.next"
mv -Tf "$APP_LINK.next" "$APP_LINK"
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

python3 - "$DATA_DIR" <<'PY'
import sqlite3
import sys
from pathlib import Path

root = Path(sys.argv[1])
database_count = 0
content_count = 0
for path in sorted(root.rglob("*.db")):
    database_count += 1
    connection = sqlite3.connect(path)
    try:
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok", path
        assert not connection.execute("PRAGMA foreign_key_check").fetchall(), path
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if "daily_stats" in tables:
            content_count += 1
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(daily_stats)")
            }
            assert {"poms_recorded_at", "poms_record_date"} <= columns, path
    finally:
        connection.close()
assert database_count >= 1
assert content_count >= 1
print(f"DATABASES_OK={database_count};CONTENT_DATABASES_OK={content_count}")
PY

printf '%s  %s\n' "$APP_SHA" "$RELEASE_DIR/app.py" \
  | sha256sum -c -
printf '%s  %s\n' "$INDEX_SHA" "$RELEASE_DIR/static/index.html" \
  | sha256sum -c -
printf '%s  %s\n' "$CSS_SHA" "$RELEASE_DIR/static/app.css" \
  | sha256sum -c -
printf '%s  %s\n' "$JS_SHA" "$RELEASE_DIR/static/app.js" \
  | sha256sum -c -

curl -fsS "$PUBLIC_BASE/?release=$RELEASE_ID" \
  -o "$STAGE_DIR/public-index.html"
curl -fsS "$PUBLIC_BASE/static/app.css?release=$RELEASE_ID" \
  -o "$STAGE_DIR/public-app.css"
curl -fsS "$PUBLIC_BASE/static/app.js?release=$RELEASE_ID" \
  -o "$STAGE_DIR/public-app.js"
printf '%s  %s\n' "$INDEX_SHA" "$STAGE_DIR/public-index.html" \
  | sha256sum -c -
printf '%s  %s\n' "$CSS_SHA" "$STAGE_DIR/public-app.css" \
  | sha256sum -c -
printf '%s  %s\n' "$JS_SHA" "$STAGE_DIR/public-app.js" \
  | sha256sum -c -

trap - ERR
echo "DEPLOY_OK"
echo "RELEASE=$RELEASE_DIR"
echo "BACKUP=$BACKUP_DIR"
echo "PREVIOUS=$OLD_RELEASE"
echo "LIVE=$(readlink -f "$APP_LINK")"
systemctl is-active daily-seal
