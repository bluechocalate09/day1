import argparse
import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import time
import unicodedata
import uuid
import warnings
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, Response, g, jsonify, request, send_file
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.middleware.proxy_fix import ProxyFix


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DAILY_SEAL_DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "daily-seal.db"
UPLOAD_DIR = DATA_DIR / "uploads"
COOKIE_SECURE = os.environ.get("DAILY_SEAL_COOKIE_SECURE", "1") != "0"
REGISTRATION_ENABLED = os.environ.get("DAILY_SEAL_REGISTRATION_ENABLED", "1") != "0"
SESSION_COOKIE = "ds_session"
CSRF_COOKIE = "ds_csrf"
SESSION_SECONDS = 7 * 24 * 60 * 60
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
# Retain the old public constant for older clients and maintenance scripts.
MAX_IMAGE_BYTES = MAX_ATTACHMENT_BYTES
MAX_IMPORT_BYTES = 1024 * 1024
EMAIL_RE = re.compile(r"^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,63}$")
PROOF_FILE_RE = re.compile(
    r"^[a-f0-9]{32}\.(?:jpg|pdf|txt|csv|docx|xlsx|pptx)$"
)
ATTACHMENT_MIME_BY_EXTENSION = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
IMAGE_FORMAT_EXTENSIONS = {
    "JPEG": {".jpg", ".jpeg"},
    "PNG": {".png"},
    "WEBP": {".webp"},
}
OOXML_MAIN_PARTS = {
    ".docx": (
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "document",
    ),
    ".xlsx": (
        "xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "workbook",
    ),
    ".pptx": (
        "ppt/presentation.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        "presentation",
    ),
}
EXECUTABLE_MAGICS = (
    b"MZ",
    b"\x7fELF",
    b"\xfe\xed\xfa\xce",
    b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
)
MAX_STAGE_TITLE_LENGTH = 200
MAX_STAGE_DESCRIPTION_LENGTH = 5000
MAX_STAGE_PROOF_TEXT_LENGTH = 1000
MAX_STAGE_PROOF_URL_LENGTH = 2048
MAX_TASK_RESULT_NOTE_LENGTH = 1000
MAX_ORIGINAL_FILENAME_BYTES = 240
MAX_PROOF_IMAGE_PIXELS = 60_000_000
Image.MAX_IMAGE_PIXELS = MAX_PROOF_IMAGE_PIXELS
RESAMPLE_LANCZOS = getattr(Image, "Resampling", Image).LANCZOS


app = Flask(__name__, static_folder="static", static_url_path="/static")
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config.update(MAX_CONTENT_LENGTH=12 * 1024 * 1024, JSON_AS_ASCII=False)


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    ip TEXT NOT NULL,
    email TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    success INTEGER NOT NULL CHECK (success IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_auth_events_lookup ON auth_events(kind, ip, email, occurred_at);
CREATE TABLE IF NOT EXISTS tasks (
    task_date TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    result_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (result_status IN ('pending', 'completed', 'incomplete')),
    completion_percent INTEGER NOT NULL DEFAULT 0
        CHECK (completion_percent >= 0 AND completion_percent <= 100),
    result_note TEXT NOT NULL DEFAULT '',
    result_recorded_at INTEGER,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    proof_text TEXT,
    proof_url TEXT,
    proof_file TEXT,
    proof_mime TEXT,
    proof_original_name TEXT,
    proof_size INTEGER CHECK (proof_size IS NULL OR proof_size >= 0)
);
CREATE TABLE IF NOT EXISTS daily_stats (
    stat_date TEXT PRIMARY KEY,
    poms INTEGER NOT NULL DEFAULT 0 CHECK (poms >= 0),
    note TEXT NOT NULL DEFAULT '',
    distractions TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    started_at INTEGER NOT NULL,
    started_date TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    completed_date TEXT,
    duration_days INTEGER CHECK (duration_days IS NULL OR duration_days >= 1),
    proof_text TEXT,
    proof_url TEXT,
    proof_file TEXT,
    proof_mime TEXT,
    proof_original_name TEXT,
    proof_size INTEGER CHECK (proof_size IS NULL OR proof_size >= 0),
    CHECK (
        (status = 'active' AND completed_at IS NULL AND completed_date IS NULL AND duration_days IS NULL)
        OR
        (status = 'completed' AND completed_at IS NOT NULL AND completed_date IS NOT NULL AND duration_days IS NOT NULL)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stages_single_active
    ON stages(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_stages_completed_date ON stages(completed_date);
"""


def now_ts():
    return int(time.time())


def utc_iso(timestamp):
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds")


def business_today_key():
    """Daily Seal follows China Standard Time regardless of server location."""
    return (datetime.now(timezone.utc) + timedelta(hours=8)).date().isoformat()


def get_db():
    if "db" not in g:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(DB_PATH), timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 15000")
        g.db = connection
    return g.db


@app.teardown_appcontext
def close_db(_error=None):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def ensure_column(connection, table, column, definition):
    columns = {
        row[1] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
    }
    if column in columns:
        return
    try:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    except sqlite3.OperationalError as error:
        # Gunicorn workers can initialize concurrently. Only ignore the race
        # where another worker added the same column first.
        if "duplicate column name" not in str(error).lower():
            raise


def backfill_legacy_attachment_metadata(connection, table, key_column):
    rows = connection.execute(
        f"SELECT {key_column}, proof_file, proof_mime, proof_original_name, proof_size "
        f"FROM {table} WHERE proof_file IS NOT NULL"
    ).fetchall()
    for row in rows:
        filename = row[1]
        if not isinstance(filename, str) or not PROOF_FILE_RE.fullmatch(filename):
            continue
        suffix = Path(filename).suffix.lower()
        mime = row[2] or (
            "image/jpeg" if suffix == ".jpg" else ATTACHMENT_MIME_BY_EXTENSION.get(suffix)
        )
        original_name = row[3]
        if not original_name:
            original_name = "证明图片.jpg" if mime == "image/jpeg" else f"证明附件{suffix}"
        size = row[4]
        if size is None:
            try:
                size = (UPLOAD_DIR / filename).stat().st_size
            except OSError:
                size = None
        connection.execute(
            f"UPDATE {table} SET proof_mime = COALESCE(proof_mime, ?), "
            "proof_original_name = COALESCE(proof_original_name, ?), "
            "proof_size = COALESCE(proof_size, ?) "
            f"WHERE {key_column} = ?",
            (mime, original_name, size, row[0]),
        )


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(DB_PATH), timeout=15)
    try:
        connection.executescript(SCHEMA)
        ensure_column(connection, "tasks", "proof_url", "TEXT")
        ensure_column(
            connection,
            "tasks",
            "result_status",
            "TEXT NOT NULL DEFAULT 'pending' "
            "CHECK (result_status IN ('pending', 'completed', 'incomplete'))",
        )
        ensure_column(
            connection,
            "tasks",
            "completion_percent",
            "INTEGER NOT NULL DEFAULT 0 "
            "CHECK (completion_percent >= 0 AND completion_percent <= 100)",
        )
        ensure_column(connection, "tasks", "result_note", "TEXT NOT NULL DEFAULT ''")
        ensure_column(connection, "tasks", "result_recorded_at", "INTEGER")
        ensure_column(connection, "tasks", "proof_original_name", "TEXT")
        ensure_column(
            connection,
            "tasks",
            "proof_size",
            "INTEGER CHECK (proof_size IS NULL OR proof_size >= 0)",
        )
        ensure_column(connection, "stages", "proof_original_name", "TEXT")
        ensure_column(
            connection,
            "stages",
            "proof_size",
            "INTEGER CHECK (proof_size IS NULL OR proof_size >= 0)",
        )
        ensure_column(
            connection,
            "daily_stats",
            "distractions",
            "TEXT NOT NULL DEFAULT ''",
        )
        connection.execute(
            "UPDATE tasks SET result_status = 'completed', completion_percent = 100, "
            "result_note = CASE WHEN result_note = '' THEN COALESCE(proof_text, '') "
            "ELSE result_note END, "
            "result_recorded_at = COALESCE(result_recorded_at, completed_at, created_at) "
            "WHERE done = 1 AND result_status = 'pending'"
        )
        backfill_legacy_attachment_metadata(connection, "tasks", "task_date")
        backfill_legacy_attachment_metadata(connection, "stages", "id")
        connection.commit()
        connection.execute("PRAGMA journal_mode = WAL")
        connection.commit()
    finally:
        connection.close()


def normalize_email(value):
    if not isinstance(value, str):
        return None
    email = value.strip().lower()
    if len(email) > 254 or not EMAIL_RE.fullmatch(email):
        return None
    return email


def validate_password(value):
    return isinstance(value, str) and 10 <= len(value) <= 128


def hash_password(password):
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=16384, r=8, p=1,
        maxmem=64 * 1024 * 1024, dklen=64
    )
    return f"scrypt$16384$8$1${salt.hex()}${derived.hex()}"


def verify_password(password, encoded):
    try:
        scheme, n, r, p, salt_hex, digest_hex = encoded.split("$")
        if scheme != "scrypt":
            return False
        derived = hashlib.scrypt(
            password.encode("utf-8"), salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p), maxmem=64 * 1024 * 1024,
            dklen=len(bytes.fromhex(digest_hex))
        )
        return hmac.compare_digest(derived, bytes.fromhex(digest_hex))
    except (ValueError, TypeError, MemoryError):
        return False


DUMMY_PASSWORD_HASH = hash_password("daily-seal-dummy-password")


def token_hash(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def user_agent_hash():
    value = request.headers.get("User-Agent", "")[:512]
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def cookie_options(http_only):
    return {
        "secure": COOKIE_SECURE,
        "httponly": http_only,
        "samesite": "Lax",
        "path": "/",
    }


def create_session(user_id):
    raw_token = secrets.token_urlsafe(32)
    csrf_token = secrets.token_urlsafe(32)
    current = now_ts()
    database = get_db()
    database.execute("DELETE FROM sessions WHERE expires_at <= ?", (current,))
    database.execute(
        "INSERT INTO sessions(token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at, user_agent_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (token_hash(raw_token), user_id, csrf_token, current, current + SESSION_SECONDS, current, user_agent_hash())
    )
    rows = database.execute(
        "SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC", (user_id,)
    ).fetchall()
    for row in rows[4:]:
        database.execute("DELETE FROM sessions WHERE token_hash = ?", (row["token_hash"],))
    database.commit()
    return raw_token, csrf_token


def set_auth_cookies(response, raw_token, csrf_token):
    response.set_cookie(SESSION_COOKIE, raw_token, max_age=SESSION_SECONDS, **cookie_options(True))
    response.set_cookie(CSRF_COOKIE, csrf_token, max_age=SESSION_SECONDS, **cookie_options(False))
    return response


def clear_auth_cookies(response):
    response.delete_cookie(SESSION_COOKIE, **cookie_options(True))
    response.delete_cookie(CSRF_COOKIE, **cookie_options(False))
    return response


@app.before_request
def load_session():
    g.current_user = None
    g.current_session = None
    raw_token = request.cookies.get(SESSION_COOKIE)
    if not raw_token or len(raw_token) > 128:
        return
    database = get_db()
    current = now_ts()
    row = database.execute(
        "SELECT s.token_hash, s.csrf_token, s.expires_at, s.last_seen_at, s.user_agent_hash, "
        "u.id, u.email, u.role, u.must_change_password "
        "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
        (token_hash(raw_token),)
    ).fetchone()
    if not row:
        return
    if row["expires_at"] <= current or not hmac.compare_digest(row["user_agent_hash"], user_agent_hash()):
        database.execute("DELETE FROM sessions WHERE token_hash = ?", (row["token_hash"],))
        database.commit()
        return
    g.current_session = {
        "token_hash": row["token_hash"],
        "csrf_token": row["csrf_token"],
        "expires_at": row["expires_at"],
    }
    g.current_user = {
        "id": row["id"],
        "email": row["email"],
        "role": row["role"],
        "must_change_password": bool(row["must_change_password"]),
    }
    if current - row["last_seen_at"] > 300:
        database.execute("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", (current, row["token_hash"]))
        database.commit()


def api_error(message, status=400, code="bad_request"):
    return jsonify({"ok": False, "error": message, "code": code}), status


def require_auth(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        if not g.current_user:
            return api_error("请先登录。", 401, "authentication_required")
        return function(*args, **kwargs)
    return wrapped


def require_owner(function):
    @wraps(function)
    @require_auth
    def wrapped(*args, **kwargs):
        if g.current_user["role"] != "owner":
            return api_error("当前账号只有查看权限。", 403, "read_only")
        if g.current_user["must_change_password"]:
            return api_error("请先修改临时密码。", 428, "password_change_required")
        return function(*args, **kwargs)
    return wrapped


def require_csrf(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        header = request.headers.get("X-CSRF-Token", "")
        cookie = request.cookies.get(CSRF_COOKIE, "")
        expected = g.current_session["csrf_token"] if g.current_session else cookie
        if not header or not cookie or not expected:
            return api_error("安全校验失败，请刷新页面重试。", 403, "csrf_failed")
        if not hmac.compare_digest(header, cookie) or not hmac.compare_digest(header, expected):
            return api_error("安全校验失败，请刷新页面重试。", 403, "csrf_failed")
        return function(*args, **kwargs)
    return wrapped


def parse_json():
    if not request.is_json:
        return None
    value = request.get_json(silent=True)
    return value if isinstance(value, dict) else None


def validate_date_key(value):
    if not isinstance(value, str) or len(value) != 10:
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    if not 2020 <= parsed.year <= 2100:
        return None
    return parsed.isoformat()


def truncate_utf8(value, maximum):
    while value and len(value.encode("utf-8")) > maximum:
        value = value[:-1]
    return value


def sanitize_original_filename(value):
    if not isinstance(value, str):
        return None
    # Browsers normally send only a basename, but some clients still include a
    # Windows or POSIX path. Never persist or reflect those path components.
    name = value.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(
        character
        for character in name
        if ord(character) >= 32
        and ord(character) != 127
        and unicodedata.category(character) not in {"Cc", "Cf"}
    )
    name = re.sub(r'[<>:"|?*]', "_", name).strip().rstrip(".")
    if not name or name in {".", ".."}:
        return None
    suffix = Path(name).suffix
    if len(name.encode("utf-8")) > MAX_ORIGINAL_FILENAME_BYTES:
        suffix_bytes = len(suffix.encode("utf-8"))
        stem_limit = max(1, MAX_ORIGINAL_FILENAME_BYTES - suffix_bytes)
        stem = truncate_utf8(name[: -len(suffix)] if suffix else name, stem_limit)
        name = f"{stem}{suffix}"
    return name


def canonical_mime_for_internal_file(filename):
    suffix = Path(filename).suffix.lower()
    if suffix == ".jpg":
        return "image/jpeg"
    return ATTACHMENT_MIME_BY_EXTENSION.get(suffix)


def proof_file_fields(row):
    filename = row["proof_file"]
    if not filename or not PROOF_FILE_RE.fullmatch(filename):
        return {
            "proofFileUrl": None,
            "proofFileName": None,
            "proofFileMime": None,
            "proofFileSize": None,
            "proofImageUrl": None,
        }
    mime = canonical_mime_for_internal_file(filename)
    suffix = Path(filename).suffix.lower()
    fallback_name = "证明图片.jpg" if mime == "image/jpeg" else f"证明附件{suffix}"
    original_name = sanitize_original_filename(row["proof_original_name"]) or fallback_name
    size = row["proof_size"]
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        try:
            size = (UPLOAD_DIR / filename).stat().st_size
        except OSError:
            size = None
    url = f"/api/proofs/{filename}"
    return {
        "proofFileUrl": url,
        "proofFileName": original_name,
        "proofFileMime": mime,
        "proofFileSize": size,
        "proofImageUrl": url if mime == "image/jpeg" else None,
    }


def serialize_task(row):
    result_status = row["result_status"]
    if result_status not in {"pending", "completed", "incomplete"}:
        result_status = "completed" if row["done"] else "pending"
    completion_percent = row["completion_percent"]
    if not isinstance(completion_percent, int) or isinstance(completion_percent, bool):
        completion_percent = 100 if result_status == "completed" else 0
    completion_percent = min(100, max(0, completion_percent))
    if result_status == "completed":
        completion_percent = 100
    result_note = row["result_note"] or row["proof_text"] or ""
    payload = {
        "date": row["task_date"],
        "text": row["text"],
        "done": bool(row["done"]),
        "resultStatus": result_status,
        "completionPercent": completion_percent,
        "resultNote": result_note,
        "resultRecordedAt": utc_iso(row["result_recorded_at"] or row["completed_at"]),
        "createdAt": utc_iso(row["created_at"]),
        "completedAt": utc_iso(row["completed_at"]),
        "proofText": row["proof_text"] or "",
        "proofUrl": row["proof_url"] or "",
    }
    payload.update(proof_file_fields(row))
    return payload


def validate_stage_fields(payload, existing=None):
    """Return normalized stage title/description or ``None`` when invalid."""
    if not isinstance(payload, dict):
        return None
    title_value = payload.get("title", existing["title"] if existing is not None else None)
    description_value = payload.get(
        "description", existing["description"] if existing is not None else ""
    )
    if not isinstance(title_value, str) or not isinstance(description_value, str):
        return None
    title = title_value.strip()
    description = description_value.strip()
    if not title or len(title) > MAX_STAGE_TITLE_LENGTH:
        return None
    if len(description) > MAX_STAGE_DESCRIPTION_LENGTH:
        return None
    return title, description


def validate_proof_url(value):
    if value is None or value == "":
        return ""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return ""
    if len(value) > MAX_STAGE_PROOF_URL_LENGTH or any(character.isspace() for character in value):
        return None
    try:
        parsed = urlsplit(value)
        # Accessing .port performs an additional validity check.
        parsed.port
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username is not None or parsed.password is not None:
        return None
    return value


def serialize_stage(row):
    payload = {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "status": row["status"],
        "startedAt": utc_iso(row["started_at"]),
        "startDate": row["started_date"],
        "updatedAt": utc_iso(row["updated_at"]),
        "completedAt": utc_iso(row["completed_at"]),
        "completionDate": row["completed_date"],
        "durationDays": row["duration_days"],
        "proofText": row["proof_text"] or "",
        "proofUrl": row["proof_url"] or "",
    }
    payload.update(proof_file_fields(row))
    return payload


def client_ip():
    return (request.remote_addr or "unknown")[:64]


def auth_limited(kind, email, seconds, maximum):
    cutoff = now_ts() - seconds
    row = get_db().execute(
        "SELECT COUNT(*) AS count FROM auth_events WHERE kind = ? AND ip = ? AND email = ? "
        "AND occurred_at >= ? AND success = 0",
        (kind, client_ip(), email, cutoff)
    ).fetchone()
    return row["count"] >= maximum


def auth_ip_limited(kind, seconds, maximum, failures_only=False):
    cutoff = now_ts() - seconds
    success_clause = "AND success = 0" if failures_only else ""
    row = get_db().execute(
        f"SELECT COUNT(*) AS count FROM auth_events WHERE kind = ? AND ip = ? "
        f"AND occurred_at >= ? {success_clause}",
        (kind, client_ip(), cutoff),
    ).fetchone()
    return row["count"] >= maximum


def record_auth_event(kind, email, success):
    database = get_db()
    database.execute(
        "INSERT INTO auth_events(kind, ip, email, occurred_at, success) VALUES (?, ?, ?, ?, ?)",
        (kind, client_ip(), email, now_ts(), 1 if success else 0)
    )
    database.execute("DELETE FROM auth_events WHERE occurred_at < ?", (now_ts() - 2 * 24 * 60 * 60,))
    database.commit()


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; "
        "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
        "frame-ancestors 'none'; form-action 'self'"
    )
    if COOKIE_SECURE:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.path.startswith("/api/") or request.path == "/":
        response.headers["Cache-Control"] = "no-store"
    return response


@app.errorhandler(413)
def request_too_large(_error):
    return api_error("附件不能超过 10 MB。", 413, "attachment_too_large")


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return api_error("未找到请求的内容。", 404, "not_found")
    return send_file(BASE_DIR / "static" / "index.html")


@app.errorhandler(500)
def internal_error(_error):
    connection = g.get("db")
    if connection is not None:
        connection.rollback()
    return api_error("服务器暂时无法处理请求。", 500, "server_error")


@app.get("/")
def index():
    return send_file(BASE_DIR / "static" / "index.html")


@app.get("/api/session")
def session_info():
    csrf_token = g.current_session["csrf_token"] if g.current_session else request.cookies.get(CSRF_COOKIE)
    if not csrf_token or len(csrf_token) < 32:
        csrf_token = secrets.token_urlsafe(32)
    user = None
    if g.current_user:
        user = {
            "email": g.current_user["email"],
            "role": g.current_user["role"],
            "mustChangePassword": g.current_user["must_change_password"],
        }
    response = jsonify({
        "ok": True,
        "authenticated": bool(user),
        "user": user,
        "csrfToken": csrf_token,
        "registrationOpen": REGISTRATION_ENABLED,
    })
    response.set_cookie(CSRF_COOKIE, csrf_token, max_age=SESSION_SECONDS, **cookie_options(False))
    if request.cookies.get(SESSION_COOKIE) and not g.current_user:
        response.delete_cookie(SESSION_COOKIE, **cookie_options(True))
    return response


@app.post("/api/register")
@require_csrf
def register():
    if not REGISTRATION_ENABLED:
        return api_error("暂未开放新账号注册。", 403, "registration_closed")
    payload = parse_json()
    if not payload:
        return api_error("请输入有效的注册信息。")
    email = normalize_email(payload.get("email"))
    password = payload.get("password")
    if not email or not validate_password(password):
        return api_error("请输入有效邮箱，密码需为 10–128 个字符。")
    if auth_limited("register", email, 3600, 5) or auth_ip_limited("register", 3600, 10):
        return api_error("注册尝试过多，请稍后再试。", 429, "rate_limited")
    database = get_db()
    try:
        cursor = database.execute(
            "INSERT INTO users(email, password_hash, role, must_change_password, created_at) VALUES (?, ?, 'viewer', 0, ?)",
            (email, hash_password(password), now_ts())
        )
        database.commit()
    except sqlite3.IntegrityError:
        record_auth_event("register", email, False)
        return api_error("该邮箱无法注册，请直接登录或更换邮箱。", 409, "email_unavailable")
    record_auth_event("register", email, True)
    raw_token, csrf_token = create_session(cursor.lastrowid)
    response = jsonify({"ok": True, "user": {"email": email, "role": "viewer", "mustChangePassword": False}})
    return set_auth_cookies(response, raw_token, csrf_token)


@app.post("/api/login")
@require_csrf
def login():
    payload = parse_json()
    if not payload:
        return api_error("邮箱或密码不正确。", 401, "invalid_credentials")
    email = normalize_email(payload.get("email")) or "invalid"
    password = payload.get("password") if isinstance(payload.get("password"), str) else ""
    if auth_limited("login", email, 15 * 60, 5) or auth_ip_limited("login", 15 * 60, 30, True):
        return api_error("登录尝试过多，请 15 分钟后再试。", 429, "rate_limited")
    database = get_db()
    user = database.execute(
        "SELECT id, email, password_hash, role, must_change_password FROM users WHERE email = ?", (email,)
    ).fetchone()
    valid = verify_password(password[:128], user["password_hash"] if user else DUMMY_PASSWORD_HASH)
    if not user or not valid:
        record_auth_event("login", email, False)
        return api_error("邮箱或密码不正确。", 401, "invalid_credentials")
    database.execute(
        "DELETE FROM auth_events WHERE kind = 'login' AND ip = ? AND email = ? AND success = 0",
        (client_ip(), email),
    )
    database.commit()
    record_auth_event("login", email, True)
    database.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now_ts(), user["id"]))
    database.commit()
    raw_token, csrf_token = create_session(user["id"])
    response = jsonify({
        "ok": True,
        "user": {
            "email": user["email"],
            "role": user["role"],
            "mustChangePassword": bool(user["must_change_password"]),
        }
    })
    return set_auth_cookies(response, raw_token, csrf_token)


@app.post("/api/logout")
@require_csrf
def logout():
    if g.current_session:
        database = get_db()
        database.execute("DELETE FROM sessions WHERE token_hash = ?", (g.current_session["token_hash"],))
        database.commit()
    return clear_auth_cookies(jsonify({"ok": True}))


@app.post("/api/change-password")
@require_auth
@require_csrf
def change_password():
    payload = parse_json()
    current_password = payload.get("currentPassword") if payload else None
    new_password = payload.get("newPassword") if payload else None
    if not isinstance(current_password, str) or not validate_password(new_password):
        return api_error("新密码需为 10–128 个字符。")
    database = get_db()
    row = database.execute("SELECT password_hash FROM users WHERE id = ?", (g.current_user["id"],)).fetchone()
    if not verify_password(current_password[:128], row["password_hash"]):
        return api_error("当前密码不正确。", 401, "invalid_credentials")
    if hmac.compare_digest(current_password, new_password):
        return api_error("新密码不能与当前密码相同。")
    database.execute(
        "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
        (hash_password(new_password), g.current_user["id"])
    )
    database.execute("DELETE FROM sessions WHERE user_id = ?", (g.current_user["id"],))
    database.commit()
    raw_token, csrf_token = create_session(g.current_user["id"])
    response = jsonify({"ok": True})
    return set_auth_cookies(response, raw_token, csrf_token)


@app.get("/api/data")
@require_auth
def get_data():
    database = get_db()
    if g.current_user["role"] == "owner":
        task_rows = database.execute("SELECT * FROM tasks ORDER BY task_date").fetchall()
    else:
        task_rows = database.execute(
            "SELECT * FROM tasks WHERE task_date <= ? ORDER BY task_date",
            (business_today_key(),),
        ).fetchall()
    tasks = [serialize_task(row) for row in task_rows]
    payload = {
        "ok": True,
        "tasks": tasks,
        "user": {
            "email": g.current_user["email"],
            "role": g.current_user["role"],
            "mustChangePassword": g.current_user["must_change_password"],
        },
    }
    public_cutoff = business_today_key()
    if g.current_user["role"] == "owner":
        stat_rows = database.execute(
            "SELECT * FROM daily_stats ORDER BY stat_date"
        ).fetchall()
        payload["stats"] = {
            row["stat_date"]: {
                "poms": row["poms"],
                "note": row["note"],
                "distractions": row["distractions"],
            }
            for row in stat_rows
        }
        public_pom_rows = stat_rows
    else:
        # Select only explicitly public columns for viewers so private text can
        # never enter their response object, even accidentally.
        public_pom_rows = database.execute(
            "SELECT stat_date, poms FROM daily_stats "
            "WHERE stat_date <= ? AND poms > 0 ORDER BY stat_date",
            (public_cutoff,),
        ).fetchall()
    payload["publicPoms"] = {
        row["stat_date"]: row["poms"]
        for row in public_pom_rows
        if row["poms"] > 0 and row["stat_date"] <= public_cutoff
    }
    return jsonify(payload)


def parse_stage_year(value):
    if value is None or value == "":
        return None
    try:
        year = int(value)
    except (TypeError, ValueError):
        return False
    return year if 2020 <= year <= 2100 else False


@app.get("/api/stages")
@app.get("/api/stages/year/<int:path_year>")
@require_auth
def list_stages(path_year=None):
    year = parse_stage_year(path_year if path_year is not None else request.args.get("year"))
    if year is False:
        return api_error("年份无效。")
    database = get_db()
    active_row = database.execute(
        "SELECT * FROM stages WHERE status = 'active' LIMIT 1"
    ).fetchone()
    if year is None:
        completed_rows = database.execute(
            "SELECT * FROM stages WHERE status = 'completed' "
            "ORDER BY completed_date DESC, id DESC"
        ).fetchall()
    else:
        completed_rows = database.execute(
            "SELECT * FROM stages WHERE status = 'completed' "
            "AND completed_date >= ? AND completed_date <= ? "
            "ORDER BY completed_date DESC, id DESC",
            (f"{year:04d}-01-01", f"{year:04d}-12-31"),
        ).fetchall()
    return jsonify({
        "ok": True,
        "activeStage": serialize_stage(active_row) if active_row else None,
        "completedStages": [serialize_stage(row) for row in completed_rows],
        "completionDates": [
            {"date": row["completed_date"], "stageId": row["id"]}
            for row in completed_rows
        ],
    })


@app.get("/api/stages/<int:stage_id>")
@require_auth
def get_stage(stage_id):
    row = get_db().execute("SELECT * FROM stages WHERE id = ?", (stage_id,)).fetchone()
    if not row:
        return api_error("未找到该阶段。", 404, "not_found")
    return jsonify({"ok": True, "stage": serialize_stage(row)})


@app.post("/api/stages")
@require_owner
@require_csrf
def create_stage():
    fields = validate_stage_fields(parse_json())
    if not fields:
        return api_error("阶段标题或说明无效，标题不能超过 200 字，说明不能超过 5000 字。")
    title, description = fields
    database = get_db()
    if database.execute("SELECT 1 FROM stages WHERE status = 'active'").fetchone():
        return api_error("请先完成当前阶段，再新建下一阶段。", 409, "active_stage_exists")
    current = now_ts()
    try:
        cursor = database.execute(
            "INSERT INTO stages(title, description, status, started_at, started_date, updated_at) "
            "VALUES (?, ?, 'active', ?, ?, ?)",
            (title, description, current, business_today_key(), current),
        )
        database.commit()
    except sqlite3.IntegrityError:
        database.rollback()
        return api_error("请先完成当前阶段，再新建下一阶段。", 409, "active_stage_exists")
    row = database.execute("SELECT * FROM stages WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return jsonify({"ok": True, "stage": serialize_stage(row)}), 201


@app.put("/api/stages/<int:stage_id>")
@require_owner
@require_csrf
def update_stage(stage_id):
    database = get_db()
    row = database.execute("SELECT * FROM stages WHERE id = ?", (stage_id,)).fetchone()
    if not row:
        return api_error("未找到该阶段。", 404, "not_found")
    if row["status"] != "active":
        return api_error("已完成的阶段不能修改。", 409, "stage_completed")
    fields = validate_stage_fields(parse_json(), row)
    if not fields:
        return api_error("阶段标题或说明无效，标题不能超过 200 字，说明不能超过 5000 字。")
    title, description = fields
    cursor = database.execute(
        "UPDATE stages SET title = ?, description = ?, updated_at = ? "
        "WHERE id = ? AND status = 'active'",
        (title, description, now_ts(), stage_id),
    )
    if cursor.rowcount != 1:
        database.rollback()
        return api_error("已完成的阶段不能修改。", 409, "stage_completed")
    database.commit()
    updated = database.execute("SELECT * FROM stages WHERE id = ?", (stage_id,)).fetchone()
    return jsonify({"ok": True, "stage": serialize_stage(updated)})


@app.post("/api/stages/<int:stage_id>/complete")
@require_owner
@require_csrf
def complete_stage(stage_id):
    if request.is_json:
        payload = parse_json() or {}
        proof_text_value = payload.get("proofText", "")
        proof_url_value = payload.get("proofUrl", "")
        upload = None
    else:
        proof_text_value = request.form.get("proofText", "")
        proof_url_value = request.form.get("proofUrl", "")
        try:
            upload = get_proof_upload()
        except ValueError as error:
            return attachment_api_error(error)
    if not isinstance(proof_text_value, str):
        return api_error("完成说明无效。")
    proof_text = proof_text_value.strip()
    if len(proof_text) > MAX_STAGE_PROOF_TEXT_LENGTH:
        return api_error("完成说明不能超过 1000 字。")
    proof_url = validate_proof_url(proof_url_value)
    if proof_url is None:
        return api_error("证据链接必须是有效的 http 或 https 地址。")
    has_upload = bool(upload and upload.filename)

    database = get_db()
    row = database.execute("SELECT * FROM stages WHERE id = ?", (stage_id,)).fetchone()
    if not row:
        return api_error("未找到该阶段。", 404, "not_found")
    if row["status"] == "completed":
        if (
            not has_upload
            and proof_text == (row["proof_text"] or "")
            and proof_url == (row["proof_url"] or "")
        ):
            return jsonify({"ok": True, "idempotent": True, "stage": serialize_stage(row)})
        return api_error("该阶段已经完成，不能重复修改完成证明。", 409, "stage_completed")
    if not proof_text and not proof_url and not has_upload:
        return api_error("请填写完成说明、证据链接或上传一个证明附件。")

    completed_at = now_ts()
    completed_date = business_today_key()
    started_date = date.fromisoformat(row["started_date"])
    duration_days = max(1, (date.fromisoformat(completed_date) - started_date).days + 1)
    try:
        attachment = process_proof_attachment(upload)
    except ValueError as error:
        return attachment_api_error(error)
    new_file = attachment["filename"] if attachment else None
    try:
        cursor = database.execute(
            "UPDATE stages SET status = 'completed', updated_at = ?, completed_at = ?, "
            "completed_date = ?, duration_days = ?, proof_text = ?, proof_url = ?, "
            "proof_file = ?, proof_mime = ?, proof_original_name = ?, proof_size = ? "
            "WHERE id = ? AND status = 'active'",
            (
                completed_at,
                completed_at,
                completed_date,
                duration_days,
                proof_text or None,
                proof_url or None,
                new_file,
                attachment["mime"] if attachment else None,
                attachment["original_name"] if attachment else None,
                attachment["size"] if attachment else None,
                stage_id,
            ),
        )
        if cursor.rowcount != 1:
            database.rollback()
            delete_stored_proof(new_file)
            return api_error("该阶段已经完成。", 409, "stage_completed")
        database.commit()
    except Exception:
        database.rollback()
        delete_stored_proof(new_file)
        raise
    updated = database.execute("SELECT * FROM stages WHERE id = ?", (stage_id,)).fetchone()
    return jsonify({"ok": True, "idempotent": False, "stage": serialize_stage(updated)})


@app.put("/api/tasks/<task_date>")
@require_owner
@require_csrf
def set_task(task_date):
    task_date = validate_date_key(task_date)
    payload = parse_json()
    text = payload.get("text", "").strip() if payload and isinstance(payload.get("text"), str) else ""
    if not task_date or not text or len(text) > 1000:
        return api_error("任务日期或内容无效，内容不能超过 1000 字。")
    database = get_db()
    existing = database.execute(
        "SELECT done, result_status FROM tasks WHERE task_date = ?", (task_date,)
    ).fetchone()
    if existing and (existing["done"] or existing["result_status"] != "pending"):
        return api_error("已记录最终结果的任务不能直接修改。", 409, "task_recorded")
    database.execute(
        "INSERT INTO tasks(task_date, text, done, created_at) VALUES (?, ?, 0, ?) "
        "ON CONFLICT(task_date) DO UPDATE SET text = excluded.text",
        (task_date, text, now_ts())
    )
    database.commit()
    row = database.execute("SELECT * FROM tasks WHERE task_date = ?", (task_date,)).fetchone()
    return jsonify({"ok": True, "task": serialize_task(row)})


@app.delete("/api/tasks/<task_date>")
@require_owner
@require_csrf
def delete_task(task_date):
    task_date = validate_date_key(task_date)
    if not task_date:
        return api_error("任务日期无效。")
    database = get_db()
    row = database.execute(
        "SELECT done, result_status FROM tasks WHERE task_date = ?", (task_date,)
    ).fetchone()
    if row and (row["done"] or row["result_status"] != "pending"):
        return api_error("已记录最终结果的任务不能删除。", 409, "task_recorded")
    database.execute("DELETE FROM tasks WHERE task_date = ?", (task_date,))
    database.commit()
    return jsonify({"ok": True})


def validate_pdf_attachment(raw):
    if not re.match(rb"^%PDF-[12]\.\d(?:\r\n|\r|\n)", raw[:16]):
        raise ValueError("invalid_attachment")
    if b"%%EOF" not in raw[-4096:]:
        raise ValueError("invalid_attachment")


def validate_text_attachment(raw, extension):
    if b"\x00" in raw:
        raise ValueError("invalid_attachment")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("invalid_attachment") from error
    if any(ord(character) < 32 and character not in "\t\r\n\f" for character in text):
        raise ValueError("invalid_attachment")
    sample = text[:65536]
    stripped = sample.lstrip().lower()
    if (
        re.match(r"^(?:<!doctype\s+html\b|<html\b|<svg\b)", stripped)
        or re.match(r"^<\?xml[^>]*>\s*<svg\b", stripped, re.DOTALL)
        or re.search(r"<(?:script|iframe|object|embed|svg)\b", sample, re.IGNORECASE)
    ):
        raise ValueError("invalid_attachment")
    if stripped.startswith("#!") or re.search(
        r"(?:^|\n)\s*(?:"
        r"(?:['\"]use strict['\"]\s*;)|"
        r"(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|"
        r"(?:import\s+.+\s+from\s+['\"]|export\s+(?:default|const|function|class)\b)|"
        r"(?:document|window)\.[A-Za-z_$]|(?:eval|require)\s*\()",
        sample,
        re.IGNORECASE,
    ):
        raise ValueError("invalid_attachment")
    if extension == ".csv":
        try:
            for _row in csv.reader(io.StringIO(text), strict=True):
                pass
        except csv.Error as error:
            raise ValueError("invalid_attachment") from error


def validate_ooxml_attachment(raw, extension):
    expected_main, expected_content_type, expected_root = OOXML_MAIN_PARTS[extension]
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            if not infos or len(infos) > 5000:
                raise ValueError("invalid_attachment")
            total_uncompressed = 0
            names = set()
            blocked_suffixes = (
                ".exe", ".dll", ".com", ".scr", ".msi", ".bat", ".cmd",
                ".ps1", ".vbs", ".js", ".mjs", ".html", ".htm", ".svg",
            )
            for info in infos:
                name = info.filename
                normalized = name.replace("\\", "/")
                parts = normalized.split("/")
                path_parts = parts[:-1] if info.is_dir() and parts[-1] == "" else parts
                lowered = normalized.lower()
                if (
                    not name
                    or name.startswith(("/", "\\"))
                    or "\\" in name
                    or any(part in {"", ".", ".."} for part in path_parts)
                    or info.flag_bits & 0x1
                    or lowered.endswith(blocked_suffixes)
                    or lowered.endswith("vbaproject.bin")
                    or "/activex/" in f"/{lowered}"
                    or "/embeddings/" in f"/{lowered}"
                ):
                    raise ValueError("invalid_attachment")
                total_uncompressed += info.file_size
                if info.file_size > 50 * 1024 * 1024 or total_uncompressed > 100 * 1024 * 1024:
                    raise ValueError("invalid_attachment")
                names.add(normalized)
            if "[Content_Types].xml" not in names or expected_main not in names:
                raise ValueError("invalid_attachment")
            content_info = archive.getinfo("[Content_Types].xml")
            main_info = archive.getinfo(expected_main)
            if content_info.file_size > 1024 * 1024 or main_info.file_size > 10 * 1024 * 1024:
                raise ValueError("invalid_attachment")
            content_root = ET.fromstring(archive.read(content_info))
            matching_override = any(
                child.tag.rsplit("}", 1)[-1] == "Override"
                and child.attrib.get("PartName", "").lstrip("/") == expected_main
                and child.attrib.get("ContentType") == expected_content_type
                for child in content_root
            )
            if not matching_override:
                raise ValueError("invalid_attachment")
            main_root = ET.fromstring(archive.read(main_info))
            if main_root.tag.rsplit("}", 1)[-1] != expected_root:
                raise ValueError("invalid_attachment")
    except (zipfile.BadZipFile, KeyError, ET.ParseError, RuntimeError) as error:
        raise ValueError("invalid_attachment") from error


def transcode_proof_image(raw, extension):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as candidate:
                source_format = candidate.format
                candidate.verify()
            if source_format not in IMAGE_FORMAT_EXTENSIONS:
                raise ValueError("invalid_attachment")
            if extension not in IMAGE_FORMAT_EXTENSIONS[source_format]:
                raise ValueError("invalid_attachment")
            with Image.open(io.BytesIO(raw)) as source:
                image = ImageOps.exif_transpose(source)
                image.thumbnail((2400, 2400), RESAMPLE_LANCZOS)
                if image.mode in ("RGBA", "LA"):
                    rgba = image.convert("RGBA")
                    background = Image.new("RGB", rgba.size, "white")
                    background.paste(rgba, mask=rgba.getchannel("A"))
                    image = background
                else:
                    image = image.convert("RGB")
                for quality in (86, 78, 70):
                    output = io.BytesIO()
                    image.save(output, format="JPEG", quality=quality, optimize=True)
                    converted = output.getvalue()
                    if len(converted) <= MAX_ATTACHMENT_BYTES:
                        return converted
    except (
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        OSError,
        ValueError,
    ) as error:
        raise ValueError("invalid_attachment") from error
    raise ValueError("attachment_too_large")


def store_proof_bytes(raw, extension):
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{extension}"
    target = UPLOAD_DIR / filename
    temporary = UPLOAD_DIR / f".{filename}.tmp"
    try:
        with open(temporary, "xb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o640)
        os.replace(temporary, target)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return filename


def delete_stored_proof(filename):
    if not isinstance(filename, str) or not PROOF_FILE_RE.fullmatch(filename):
        return
    try:
        (UPLOAD_DIR / filename).unlink(missing_ok=True)
    except OSError:
        pass


def process_proof_attachment(upload):
    if not upload or not upload.filename:
        return None
    original_name = sanitize_original_filename(upload.filename)
    if not original_name:
        raise ValueError("invalid_attachment")
    extension = Path(original_name).suffix.lower()
    supported_extensions = {
        ".jpg", ".jpeg", ".png", ".webp", ".pdf", ".txt", ".csv",
        ".docx", ".xlsx", ".pptx",
    }
    if extension not in supported_extensions:
        raise ValueError("invalid_attachment")
    raw = upload.stream.read(MAX_ATTACHMENT_BYTES + 1)
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise ValueError("attachment_too_large")
    if not raw or raw.startswith(EXECUTABLE_MAGICS):
        raise ValueError("invalid_attachment")

    if extension in {".jpg", ".jpeg", ".png", ".webp"}:
        stored = transcode_proof_image(raw, extension)
        stored_extension = ".jpg"
        mime = "image/jpeg"
    elif extension == ".pdf":
        validate_pdf_attachment(raw)
        stored = raw
        stored_extension = extension
        mime = ATTACHMENT_MIME_BY_EXTENSION[extension]
    elif extension in {".txt", ".csv"}:
        validate_text_attachment(raw, extension)
        stored = raw
        stored_extension = extension
        mime = ATTACHMENT_MIME_BY_EXTENSION[extension]
    else:
        validate_ooxml_attachment(raw, extension)
        stored = raw
        stored_extension = extension
        mime = ATTACHMENT_MIME_BY_EXTENSION[extension]

    filename = store_proof_bytes(stored, stored_extension)
    return {
        "filename": filename,
        "original_name": original_name,
        "mime": mime,
        "size": len(stored),
    }


def get_proof_upload():
    uploads = [
        upload
        for field in ("attachment", "image")
        for upload in request.files.getlist(field)
        if upload and upload.filename
    ]
    if len(uploads) > 1:
        raise ValueError("multiple_attachments")
    return uploads[0] if uploads else None


def attachment_api_error(error):
    code = str(error)
    if code == "attachment_too_large":
        return api_error("附件不能超过 10 MB。", 413, code)
    if code == "multiple_attachments":
        return api_error("一次只能上传一个附件。", 400, code)
    return api_error(
        "附件必须是有效的 JPG、PNG、WebP、PDF、TXT、CSV、DOCX、XLSX 或 PPTX。",
        400,
        "invalid_attachment",
    )


@app.post("/api/tasks/<task_date>/complete")
@app.post("/api/tasks/<task_date>/result")
@require_owner
@require_csrf
def record_task_result(task_date):
    task_date = validate_date_key(task_date)
    if not task_date:
        return api_error("任务日期无效。")
    legacy_completion = request.path.endswith("/complete")
    result_status = request.form.get("resultStatus")
    if legacy_completion and not result_status:
        result_status = "completed"
    if result_status not in {"completed", "incomplete"}:
        return api_error("请选择完成或未完成。", 400, "invalid_result_status")

    percent_value = request.form.get("completionPercent")
    if percent_value is None and legacy_completion:
        completion_percent = 100
    elif not isinstance(percent_value, str) or not re.fullmatch(r"\d{1,3}", percent_value):
        return api_error("完成程度必须是 0 到 100 的整数。", 400, "invalid_completion_percent")
    else:
        completion_percent = int(percent_value)
    if result_status == "completed" and completion_percent != 100:
        return api_error("选择完成时，完成程度必须为 100%。", 400, "invalid_completion_percent")
    if result_status == "incomplete" and not 0 <= completion_percent <= 99:
        return api_error("选择未完成时，完成程度必须在 0% 到 99% 之间。", 400, "invalid_completion_percent")

    result_note_value = request.form.get("resultNote")
    if result_note_value is None:
        result_note_value = request.form.get("proofText", "")
    if not isinstance(result_note_value, str):
        return api_error("反馈内容无效。")
    result_note = result_note_value.strip()
    if len(result_note) > MAX_TASK_RESULT_NOTE_LENGTH:
        return api_error("反馈不能超过 1000 字。")
    if not legacy_completion and not result_note:
        label = "完成备注" if result_status == "completed" else "未完成原因"
        return api_error(f"请填写{label}。", 400, "result_note_required")

    proof_url_input = request.form.get("proofUrl")
    proof_url = validate_proof_url(proof_url_input)
    if proof_url_input is not None and proof_url is None:
        return api_error("证据链接必须是有效的 http 或 https 地址。")
    try:
        upload = get_proof_upload()
    except ValueError as error:
        return attachment_api_error(error)
    database = get_db()
    row = database.execute("SELECT * FROM tasks WHERE task_date = ?", (task_date,)).fetchone()
    if not row:
        return api_error("未找到该任务。", 404, "not_found")
    effective_proof_url = row["proof_url"] if proof_url_input is None else proof_url
    if (
        legacy_completion
        and not result_note
        and not effective_proof_url
        and (not upload or not upload.filename)
        and not row["proof_file"]
    ):
        return api_error("请填写完成说明、证据链接或上传一个证明附件。")
    try:
        attachment = process_proof_attachment(upload)
    except ValueError as error:
        return attachment_api_error(error)
    new_file = attachment["filename"] if attachment else None
    old_file = row["proof_file"]
    recorded_at = now_ts()
    completed_at = None
    if result_status == "completed":
        completed_at = (
            row["completed_at"]
            if row["result_status"] == "completed" and row["completed_at"]
            else recorded_at
        )
    try:
        cursor = database.execute(
            "UPDATE tasks SET done = ?, result_status = ?, completion_percent = ?, "
            "result_note = ?, result_recorded_at = ?, completed_at = ?, "
            "proof_text = ?, proof_url = ?, "
            "proof_file = COALESCE(?, proof_file), "
            "proof_mime = COALESCE(?, proof_mime), "
            "proof_original_name = COALESCE(?, proof_original_name), "
            "proof_size = COALESCE(?, proof_size) "
            "WHERE task_date = ? AND proof_file IS ? AND result_recorded_at IS ?",
            (
                1 if result_status == "completed" else 0,
                result_status,
                completion_percent,
                result_note,
                recorded_at,
                completed_at,
                result_note,
                effective_proof_url or None,
                new_file,
                attachment["mime"] if attachment else None,
                attachment["original_name"] if attachment else None,
                attachment["size"] if attachment else None,
                task_date,
                old_file,
                row["result_recorded_at"],
            ),
        )
        if cursor.rowcount != 1:
            database.rollback()
            delete_stored_proof(new_file)
            return api_error(
                "这条结果刚刚被更新，请刷新后重试。",
                409,
                "proof_conflict",
            )
        database.commit()
    except Exception:
        database.rollback()
        delete_stored_proof(new_file)
        raise
    if new_file and old_file and old_file != new_file:
        delete_stored_proof(old_file)
    updated = database.execute("SELECT * FROM tasks WHERE task_date = ?", (task_date,)).fetchone()
    return jsonify({"ok": True, "task": serialize_task(updated)})


@app.put("/api/stats/<stat_date>")
@require_owner
@require_csrf
def set_stats(stat_date):
    stat_date = validate_date_key(stat_date)
    payload = parse_json()
    if not stat_date or not payload:
        return api_error("记录日期或内容无效。")
    poms = payload.get("poms")
    note = payload.get("note")
    if not isinstance(poms, int) or isinstance(poms, bool) or not 0 <= poms <= 100000:
        return api_error("番茄钟数量无效。")
    if not isinstance(note, str) or len(note) > 10000:
        return api_error("便签内容不能超过 10000 字。")
    database = get_db()
    current = database.execute(
        "SELECT distractions FROM daily_stats WHERE stat_date = ?", (stat_date,)
    ).fetchone()
    distractions = payload.get(
        "distractions", current["distractions"] if current else ""
    )
    if not isinstance(distractions, str) or len(distractions) > 10000:
        return api_error("分心记录不能超过 10000 字。")
    database.execute(
        "INSERT INTO daily_stats(stat_date, poms, note, distractions, updated_at) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(stat_date) DO UPDATE SET "
        "poms = excluded.poms, note = excluded.note, "
        "distractions = excluded.distractions, updated_at = excluded.updated_at",
        (stat_date, poms, note, distractions, now_ts())
    )
    database.commit()
    return jsonify({
        "ok": True,
        "stats": {"poms": poms, "note": note, "distractions": distractions},
    })


def validate_legacy_import(value):
    if not isinstance(value, dict) or not isinstance(value.get("tasks"), dict):
        raise ValueError("invalid")
    poms = value.get("poms", {})
    imported_notes = value.get("notes", {})
    if "distractions" in value:
        # Current exports keep private notes and distraction logs separate.
        notes = imported_notes
        distractions = value.get("distractions")
    else:
        # In the original browser-only format, the misleadingly named `notes`
        # bucket was the distraction log. Preserve that meaning on import.
        notes = {}
        distractions = imported_notes
    if (
        not isinstance(poms, dict)
        or not isinstance(notes, dict)
        or not isinstance(distractions, dict)
    ):
        raise ValueError("invalid")
    if any(
        len(section) > 5000
        for section in (value["tasks"], poms, notes, distractions)
    ):
        raise ValueError("too_many")
    tasks = []
    for key, item in value["tasks"].items():
        key = validate_date_key(key)
        if not key or not isinstance(item, dict) or not isinstance(item.get("text"), str):
            raise ValueError("invalid")
        text = item["text"].strip()
        if not text or len(text) > 1000:
            raise ValueError("invalid")
        legacy_done = item.get("done") is True
        result_status = item.get("resultStatus")
        if result_status is None:
            result_status = "completed" if legacy_done else "pending"
        if result_status not in {"pending", "completed", "incomplete"}:
            raise ValueError("invalid")
        default_percent = 100 if result_status == "completed" else 0
        completion_percent = item.get("completionPercent", default_percent)
        if (
            not isinstance(completion_percent, int)
            or isinstance(completion_percent, bool)
            or not 0 <= completion_percent <= 100
            or (result_status == "completed" and completion_percent != 100)
            or (result_status == "incomplete" and completion_percent == 100)
            or (result_status == "pending" and completion_percent != 0)
        ):
            raise ValueError("invalid")
        result_note = item.get("resultNote", item.get("proofText", ""))
        if not isinstance(result_note, str) or len(result_note) > MAX_TASK_RESULT_NOTE_LENGTH:
            raise ValueError("invalid")
        if result_status == "incomplete" and not result_note.strip():
            raise ValueError("invalid")
        tasks.append((key, text, result_status, completion_percent, result_note.strip()))
    clean_poms = {}
    for key, count in poms.items():
        key = validate_date_key(key)
        if not key or not isinstance(count, int) or isinstance(count, bool) or not 0 <= count <= 100000:
            raise ValueError("invalid")
        clean_poms[key] = count
    clean_notes = {}
    for key, note in notes.items():
        key = validate_date_key(key)
        if not key or not isinstance(note, str) or len(note) > 10000:
            raise ValueError("invalid")
        clean_notes[key] = note
    clean_distractions = {}
    for key, distraction in distractions.items():
        key = validate_date_key(key)
        if not key or not isinstance(distraction, str) or len(distraction) > 10000:
            raise ValueError("invalid")
        clean_distractions[key] = distraction
    return tasks, clean_poms, clean_notes, clean_distractions


@app.post("/api/import")
@require_owner
@require_csrf
def import_data():
    if request.content_length and request.content_length > MAX_IMPORT_BYTES:
        return api_error("导入数据不能超过 1 MB。", 413, "too_large")
    payload = parse_json()
    try:
        tasks, poms, notes, distractions = validate_legacy_import(
            payload.get("data") if payload else None
        )
    except ValueError:
        return api_error("导入数据格式不正确。")
    database = get_db()
    imported_tasks = 0
    with database:
        for key, text, result_status, completion_percent, result_note in tasks:
            recorded = result_status != "pending"
            imported_at = now_ts()
            cursor = database.execute(
                "INSERT OR IGNORE INTO tasks("
                "task_date, text, done, result_status, completion_percent, result_note, "
                "result_recorded_at, created_at, completed_at, proof_text"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    key,
                    text,
                    1 if result_status == "completed" else 0,
                    result_status,
                    completion_percent,
                    result_note,
                    imported_at if recorded else None,
                    imported_at,
                    imported_at if result_status == "completed" else None,
                    result_note or None,
                ),
            )
            imported_tasks += cursor.rowcount
        for key in set(poms) | set(notes) | set(distractions):
            database.execute(
                "INSERT INTO daily_stats(stat_date, poms, note, distractions, updated_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(stat_date) DO UPDATE SET "
                "poms = CASE WHEN daily_stats.poms = 0 THEN excluded.poms ELSE daily_stats.poms END, "
                "note = CASE WHEN daily_stats.note = '' THEN excluded.note ELSE daily_stats.note END, "
                "distractions = CASE WHEN daily_stats.distractions = '' "
                "THEN excluded.distractions ELSE daily_stats.distractions END, "
                "updated_at = excluded.updated_at",
                (
                    key,
                    poms.get(key, 0),
                    notes.get(key, ""),
                    distractions.get(key, ""),
                    now_ts(),
                )
            )
    return jsonify({"ok": True, "importedTasks": imported_tasks})


@app.get("/api/export")
@require_owner
def export_data():
    database = get_db()
    tasks = {}
    for row in database.execute("SELECT * FROM tasks ORDER BY task_date").fetchall():
        serialized = serialize_task(row)
        tasks[row["task_date"]] = {
            "text": row["text"],
            "done": bool(row["done"]),
            "resultStatus": serialized["resultStatus"],
            "completionPercent": serialized["completionPercent"],
            "resultNote": serialized["resultNote"],
            "resultRecordedAt": serialized["resultRecordedAt"],
            "createdAt": utc_iso(row["created_at"]),
            "doneAt": utc_iso(row["completed_at"]),
            "proofText": row["proof_text"] or "",
            "proofUrl": row["proof_url"] or "",
            **proof_file_fields(row),
        }
    stats = database.execute("SELECT * FROM daily_stats ORDER BY stat_date").fetchall()
    stages = [
        serialize_stage(row)
        for row in database.execute("SELECT * FROM stages ORDER BY started_at, id").fetchall()
    ]
    body = json.dumps({
        "tasks": tasks,
        "poms": {row["stat_date"]: row["poms"] for row in stats},
        "notes": {row["stat_date"]: row["note"] for row in stats},
        "distractions": {row["stat_date"]: row["distractions"] for row in stats},
        "stages": stages,
    }, ensure_ascii=False, indent=2)
    filename = f"daily-seal-{business_today_key()}.json"
    return Response(
        body,
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.get("/api/proofs/<filename>")
@require_auth
def proof_image(filename):
    if not PROOF_FILE_RE.fullmatch(filename):
        return api_error("未找到证明附件。", 404, "not_found")
    database = get_db()
    row = database.execute(
        "SELECT task_date, proof_file, proof_mime, proof_original_name, proof_size "
        "FROM tasks WHERE proof_file = ?",
        (filename,),
    ).fetchone()
    stage_row = None
    if not row:
        stage_row = database.execute(
            "SELECT id, proof_file, proof_mime, proof_original_name, proof_size "
            "FROM stages WHERE proof_file = ? AND status = 'completed'",
            (filename,),
        ).fetchone()
    target = UPLOAD_DIR / filename
    if (not row and not stage_row) or not target.is_file():
        return api_error("未找到证明附件。", 404, "not_found")
    if row and g.current_user["role"] != "owner" and row["task_date"] > business_today_key():
        return api_error("未找到证明附件。", 404, "not_found")
    metadata = proof_file_fields(row or stage_row)
    mime = metadata["proofFileMime"]
    download_name = metadata["proofFileName"]
    is_image = mime == "image/jpeg"
    if is_image and Path(download_name).suffix.lower() not in {".jpg", ".jpeg"}:
        download_name = f"{Path(download_name).stem or '证明图片'}.jpg"
    return send_file(
        target,
        mimetype=mime,
        as_attachment=not is_image,
        download_name=download_name,
        conditional=True,
        max_age=3600,
    )


def seed_from_file(path):
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    email = normalize_email(config.get("email"))
    password_hash = config.get("passwordHash")
    if not email or not isinstance(password_hash, str) or not password_hash.startswith("scrypt$"):
        raise SystemExit("Invalid seed config")
    init_db()
    connection = sqlite3.connect(str(DB_PATH), timeout=15)
    try:
        existing = connection.execute("SELECT id FROM users WHERE role = 'owner'").fetchone()
        if not existing:
            connection.execute(
                "INSERT INTO users(email, password_hash, role, must_change_password, created_at) VALUES (?, ?, 'owner', 1, ?)",
                (email, password_hash, now_ts())
            )
        task = config.get("task")
        if isinstance(task, dict):
            task_date = validate_date_key(task.get("date"))
            text = task.get("text", "").strip() if isinstance(task.get("text"), str) else ""
            if task_date and text:
                connection.execute(
                    "INSERT OR IGNORE INTO tasks(task_date, text, done, created_at) VALUES (?, ?, 0, ?)",
                    (task_date, text[:1000], now_ts())
                )
        connection.commit()
    finally:
        connection.close()


init_db()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--port", type=int, default=8766)
    arguments = parser.parse_args()
    if arguments.seed:
        seed_from_file(arguments.seed)
    if arguments.serve:
        app.run(host="127.0.0.1", port=arguments.port, debug=False)
