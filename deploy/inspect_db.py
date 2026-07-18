import json
import sqlite3

connection = sqlite3.connect("/var/lib/daily-seal/daily-seal.db")
payload = {
    "tables": [
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
    ],
    "schemas": {
        table: connection.execute(f"PRAGMA table_info({table})").fetchall()
        for table in ("tasks", "users")
    },
    "task_sample": connection.execute("SELECT * FROM tasks ORDER BY 1 DESC LIMIT 5").fetchall(),
    "task_count": connection.execute("SELECT COUNT(*) FROM tasks").fetchone()[0],
    "user_count": connection.execute("SELECT COUNT(*) FROM users").fetchone()[0],
    "users": connection.execute(
        "SELECT email, role, must_change_password FROM users ORDER BY id"
    ).fetchall(),
}
print(json.dumps(payload, ensure_ascii=False))
