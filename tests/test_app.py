"""Integration tests for the Daily Seal Flask API.

The suite uses only temporary local storage and Flask's in-process test client;
it never opens a network connection or touches production data.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
import zipfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


WORK_DIR = Path(__file__).resolve().parents[1]
APP_PATH = WORK_DIR / "app" / "app.py"
VENDOR_DIR = Path(os.environ.get("DAILY_SEAL_TEST_DEPS", WORK_DIR / "vendor"))

# app.py reads these values and creates its database at import time, so they
# must be set before loading the module.
_TEMP_DATA = tempfile.TemporaryDirectory(prefix="daily-seal-tests-")
os.environ["DAILY_SEAL_DATA_DIR"] = _TEMP_DATA.name
os.environ["DAILY_SEAL_COOKIE_SECURE"] = "0"
os.environ["DAILY_SEAL_REGISTRATION_ENABLED"] = "1"
sys.path.insert(0, str(VENDOR_DIR))

_SPEC = importlib.util.spec_from_file_location("daily_seal_test_server", APP_PATH)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - import guard
    raise RuntimeError(f"Unable to import {APP_PATH}")
server = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(server)


class DailySealApiTests(unittest.TestCase):
    OWNER_EMAIL = "owner@example.test"
    OWNER_TEMP_PASSWORD = "OwnerTemp!123"
    OWNER_NEW_PASSWORD = "OwnerPermanent!456"
    VIEWER_EMAIL = "viewer@example.test"
    VIEWER_PASSWORD = "ViewerPass!123"

    @classmethod
    def setUpClass(cls):
        cls.owner_password_hash = server.hash_password(cls.OWNER_TEMP_PASSWORD)
        server.app.config.update(TESTING=True)

    @classmethod
    def tearDownClass(cls):
        _TEMP_DATA.cleanup()

    def setUp(self):
        # Every test begins with one owner using a forced-change temporary
        # password. This keeps test ordering irrelevant.
        connection = sqlite3.connect(str(server.DB_PATH))
        try:
            connection.executescript(
                """
                DELETE FROM sessions;
                DELETE FROM auth_events;
                DELETE FROM stages;
                DELETE FROM task_progress_assets;
                DELETE FROM task_progress;
                DELETE FROM tasks;
                DELETE FROM daily_stats;
                DELETE FROM users;
                """
            )
            connection.execute(
                "INSERT INTO users(email, password_hash, role, must_change_password, created_at) "
                "VALUES (?, ?, 'owner', 1, ?)",
                (self.OWNER_EMAIL, self.owner_password_hash, server.now_ts()),
            )
            connection.commit()
        finally:
            connection.close()
        for path in server.UPLOAD_DIR.glob("*"):
            if path.is_file():
                path.unlink()
        self.client = server.app.test_client()

    @contextmanager
    def db(self):
        connection = sqlite3.connect(str(server.DB_PATH))
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def csrf(self, client=None):
        client = client or self.client
        response = client.get("/api/session")
        self.assertEqual(response.status_code, 200)
        return response.get_json()["csrfToken"]

    def register_viewer(
        self,
        client=None,
        email=None,
        password=None,
    ):
        client = client or self.client
        token = self.csrf(client)
        return client.post(
            "/api/register",
            json={
                "email": email or self.VIEWER_EMAIL,
                "password": password or self.VIEWER_PASSWORD,
            },
            headers={"X-CSRF-Token": token},
        )

    def login_owner(self, client=None, password=None):
        client = client or self.client
        token = self.csrf(client)
        return client.post(
            "/api/login",
            json={
                "email": self.OWNER_EMAIL,
                "password": password or self.OWNER_TEMP_PASSWORD,
            },
            headers={"X-CSRF-Token": token},
        )

    def unlock_owner(self):
        with self.db() as connection:
            connection.execute(
                "UPDATE users SET must_change_password = 0 WHERE email = ?",
                (self.OWNER_EMAIL,),
            )

    def login_unlocked_owner(self, client=None):
        self.unlock_owner()
        response = self.login_owner(client)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return client or self.client

    @staticmethod
    def png_bytes():
        image = server.Image.new("RGBA", (32, 24), (24, 112, 224, 128))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    @staticmethod
    def mobile_48mp_jpeg_bytes():
        image = server.Image.new("L", (8000, 6000), 176)
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=72, optimize=True)
        image.close()
        return output.getvalue()

    @staticmethod
    def pdf_bytes():
        return (
            b"%PDF-1.7\n"
            b"1 0 obj\n<< /Type /Catalog >>\nendobj\n"
            b"trailer\n<< /Root 1 0 R >>\n%%EOF\n"
        )

    @staticmethod
    def ooxml_bytes(extension, extra_entries=None):
        definitions = {
            ".docx": (
                "word/document.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
            ),
            ".xlsx": (
                "xl/workbook.xml",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
            ),
            ".pptx": (
                "ppt/presentation.xml",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
                '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>',
            ),
        }
        main_part, content_type, main_xml = definitions[extension]
        content_types = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            f'<Override PartName="/{main_part}" ContentType="{content_type}"/>'
            '</Types>'
        )
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", content_types)
            archive.writestr(main_part, main_xml)
            for name, value in (extra_entries or {}).items():
                archive.writestr(name, value)
        return output.getvalue()

    def put_task(self, client, task_date="2026-07-17", text="Geometry practice"):
        return client.put(
            f"/api/tasks/{task_date}",
            json={"text": text},
            headers={"X-CSRF-Token": self.csrf(client)},
        )

    def create_progress(
        self,
        client=None,
        task_date="2026-07-17",
        note="Morning work",
        progress_percent=35,
        links=None,
    ):
        client = client or self.client
        return client.post(
            f"/api/tasks/{task_date}/progress",
            json={
                "note": note,
                "progressPercent": progress_percent,
                "links": list(links or []),
            },
            headers={"X-CSRF-Token": self.csrf(client)},
        )

    def upload_progress_file(
        self,
        progress_id,
        raw,
        name,
        client=None,
        task_date="2026-07-17",
    ):
        client = client or self.client
        return client.post(
            f"/api/tasks/{task_date}/progress/{progress_id}/files",
            data={"attachment": (io.BytesIO(raw), name)},
            headers={"X-CSRF-Token": self.csrf(client)},
        )

    def create_stage(self, client=None, title="Phase One", description="Finish the target"):
        client = client or self.client
        return client.post(
            "/api/stages",
            json={"title": title, "description": description},
            headers={"X-CSRF-Token": self.csrf(client)},
        )

    def test_anonymous_access_is_limited_and_api_errors_are_json(self):
        session = self.client.get("/api/session")
        self.assertEqual(session.status_code, 200)
        self.assertEqual(
            session.get_json(),
            {
                "ok": True,
                "authenticated": False,
                "user": None,
                "csrfToken": session.get_json()["csrfToken"],
                "registrationOpen": True,
            },
        )
        self.assertGreaterEqual(len(session.get_json()["csrfToken"]), 32)

        for path in (
            "/api/data",
            "/api/export",
            "/api/stages",
            "/api/stages/1",
            "/api/proofs/" + "a" * 32 + ".jpg",
        ):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 401, path)
            self.assertEqual(response.get_json()["code"], "authentication_required")

        anonymous_write = self.client.put(
            "/api/tasks/2026-07-17",
            json={"text": "must not be written"},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(anonymous_write.status_code, 401)
        with self.db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

        missing = self.client.get("/api/not-a-real-route")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.content_type, "application/json")
        self.assertEqual(missing.get_json()["code"], "not_found")

    def test_registration_always_creates_viewer_and_sets_safe_cookie_attributes(self):
        token = self.csrf()
        response = self.client.post(
            "/api/register",
            json={
                "email": "  VIEWER@EXAMPLE.TEST  ",
                "password": self.VIEWER_PASSWORD,
                "role": "owner",
                "mustChangePassword": True,
            },
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["user"]["role"], "viewer")
        self.assertFalse(response.get_json()["user"]["mustChangePassword"])

        with self.db() as connection:
            user = connection.execute(
                "SELECT email, role, must_change_password, password_hash FROM users WHERE email = ?",
                (self.VIEWER_EMAIL,),
            ).fetchone()
        self.assertIsNotNone(user)
        self.assertEqual(user["email"], self.VIEWER_EMAIL)
        self.assertEqual(user["role"], "viewer")
        self.assertEqual(user["must_change_password"], 0)
        self.assertNotEqual(user["password_hash"], self.VIEWER_PASSWORD)
        self.assertTrue(user["password_hash"].startswith("scrypt$"))

        cookie_lines = response.headers.getlist("Set-Cookie")
        session_cookie = next(line for line in cookie_lines if line.startswith("ds_session="))
        csrf_cookie = next(line for line in cookie_lines if line.startswith("ds_csrf="))
        self.assertIn("HttpOnly", session_cookie)
        self.assertNotIn("HttpOnly", csrf_cookie)
        self.assertIn("SameSite=Lax", session_cookie)
        self.assertIn("SameSite=Lax", csrf_cookie)
        self.assertNotIn("; Secure", session_cookie)
        self.assertNotIn("; Secure", csrf_cookie)

        session = self.client.get("/api/session").get_json()
        self.assertTrue(session["authenticated"])
        self.assertEqual(session["user"]["role"], "viewer")

    def test_viewer_password_change_preserves_read_only_role(self):
        self.assertEqual(self.register_viewer().status_code, 200)
        token = self.csrf()
        changed = self.client.post(
            "/api/change-password",
            json={
                "currentPassword": self.VIEWER_PASSWORD,
                "newPassword": "ViewerChanged!456",
            },
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(changed.status_code, 200, changed.get_data(as_text=True))

        session = self.client.get("/api/session").get_json()
        self.assertEqual(session["user"]["role"], "viewer")
        self.assertFalse(session["user"]["mustChangePassword"])
        self.assertEqual(
            self.client.put(
                "/api/tasks/2026-07-17",
                json={"text": "must stay blocked"},
                headers={"X-CSRF-Token": session["csrfToken"]},
            ).status_code,
            403,
        )
        self.assertEqual(self.client.get("/api/export").status_code, 403)

    def test_registration_validates_input_and_duplicate_email(self):
        token = self.csrf()
        invalid_email = self.client.post(
            "/api/register",
            json={"email": "not-an-email", "password": self.VIEWER_PASSWORD},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(invalid_email.status_code, 400)

        short_password = self.client.post(
            "/api/register",
            json={"email": self.VIEWER_EMAIL, "password": "short"},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(short_password.status_code, 400)

        self.assertEqual(self.register_viewer().status_code, 200)
        duplicate = self.register_viewer(
            client=server.app.test_client(),
            email=self.VIEWER_EMAIL.upper(),
            password="AnotherPass!123",
        )
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(duplicate.get_json()["code"], "email_unavailable")

    def test_registration_can_be_closed_by_configuration(self):
        original = server.REGISTRATION_ENABLED
        server.REGISTRATION_ENABLED = False
        try:
            client = server.app.test_client()
            session = client.get("/api/session")
            self.assertFalse(session.get_json()["registrationOpen"])
            blocked = client.post(
                "/api/register",
                json={"email": self.VIEWER_EMAIL, "password": self.VIEWER_PASSWORD},
                headers={"X-CSRF-Token": session.get_json()["csrfToken"]},
            )
            self.assertEqual(blocked.status_code, 403)
            self.assertEqual(blocked.get_json()["code"], "registration_closed")
            with self.db() as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)
        finally:
            server.REGISTRATION_ENABLED = original

    def test_csrf_is_required_for_anonymous_and_authenticated_mutations(self):
        # Anonymous registration requires the double-submit CSRF value.
        self.csrf()
        missing = self.client.post(
            "/api/register",
            json={"email": self.VIEWER_EMAIL, "password": self.VIEWER_PASSWORD},
        )
        self.assertEqual(missing.status_code, 403)
        self.assertEqual(missing.get_json()["code"], "csrf_failed")
        mismatch = self.client.post(
            "/api/register",
            json={"email": self.VIEWER_EMAIL, "password": self.VIEWER_PASSWORD},
            headers={"X-CSRF-Token": "wrong-token"},
        )
        self.assertEqual(mismatch.status_code, 403)

        # An authenticated owner is subject to the same check on management
        # mutations; no database change occurs on either failure.
        self.login_unlocked_owner()
        missing = self.client.put(
            "/api/tasks/2026-07-17",
            json={"text": "blocked"},
        )
        self.assertEqual(missing.status_code, 403)
        self.assertEqual(missing.get_json()["code"], "csrf_failed")
        mismatch = self.client.put(
            "/api/tasks/2026-07-17",
            json={"text": "blocked"},
            headers={"X-CSRF-Token": "wrong-token"},
        )
        self.assertEqual(mismatch.status_code, 403)
        with self.db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

        allowed = self.put_task(self.client)
        self.assertEqual(allowed.status_code, 200)

    def test_owner_is_forced_to_change_temporary_password_before_writes(self):
        login = self.login_owner()
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.get_json()["user"]["role"], "owner")
        self.assertTrue(login.get_json()["user"]["mustChangePassword"])

        data = self.client.get("/api/data")
        self.assertEqual(data.status_code, 200)
        self.assertIn("stats", data.get_json())
        blocked = self.put_task(self.client)
        self.assertEqual(blocked.status_code, 428)
        self.assertEqual(blocked.get_json()["code"], "password_change_required")

        with self.db() as connection:
            old_session_hash = connection.execute(
                "SELECT token_hash FROM sessions"
            ).fetchone()["token_hash"]

        changed = self.client.post(
            "/api/change-password",
            json={
                "currentPassword": self.OWNER_TEMP_PASSWORD,
                "newPassword": self.OWNER_NEW_PASSWORD,
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(changed.status_code, 200, changed.get_data(as_text=True))
        with self.db() as connection:
            owner = connection.execute(
                "SELECT password_hash, must_change_password FROM users WHERE email = ?",
                (self.OWNER_EMAIL,),
            ).fetchone()
            sessions = connection.execute(
                "SELECT token_hash FROM sessions WHERE user_id = "
                "(SELECT id FROM users WHERE email = ?)",
                (self.OWNER_EMAIL,),
            ).fetchall()
        self.assertEqual(owner["must_change_password"], 0)
        self.assertTrue(server.verify_password(self.OWNER_NEW_PASSWORD, owner["password_hash"]))
        self.assertEqual(len(sessions), 1)
        self.assertNotEqual(sessions[0]["token_hash"], old_session_hash)
        self.assertEqual(self.put_task(self.client).status_code, 200)

        old_password_client = server.app.test_client()
        self.assertEqual(
            self.login_owner(old_password_client, self.OWNER_TEMP_PASSWORD).status_code,
            401,
        )
        new_password_client = server.app.test_client()
        self.assertEqual(
            self.login_owner(new_password_client, self.OWNER_NEW_PASSWORD).status_code,
            200,
        )

    def test_viewer_cannot_call_any_owner_write_or_export_endpoint(self):
        registered = self.register_viewer()
        self.assertEqual(registered.status_code, 200)
        token = self.csrf()
        attempts = [
            self.client.put(
                "/api/tasks/2026-07-17",
                json={"text": "forbidden"},
                headers={"X-CSRF-Token": token},
            ),
            self.client.delete(
                "/api/tasks/2026-07-17",
                headers={"X-CSRF-Token": token},
            ),
            self.client.post(
                "/api/tasks/2026-07-17/complete",
                data={"proofText": "forbidden"},
                headers={"X-CSRF-Token": token},
            ),
            self.client.post(
                "/api/tasks/2026-07-17/result",
                data={
                    "resultStatus": "incomplete",
                    "completionPercent": "50",
                    "resultNote": "forbidden",
                },
                headers={"X-CSRF-Token": token},
            ),
            self.client.post(
                "/api/tasks/2026-07-17/progress",
                json={
                    "note": "forbidden",
                    "progressPercent": 25,
                    "links": ["https://example.test/forbidden"],
                },
                headers={"X-CSRF-Token": token},
            ),
            self.client.post(
                "/api/tasks/2026-07-17/progress/1/files",
                data={"attachment": (io.BytesIO(b"forbidden"), "forbidden.txt")},
                headers={"X-CSRF-Token": token},
            ),
            self.client.delete(
                "/api/tasks/2026-07-17/progress/1/assets/1",
                headers={"X-CSRF-Token": token},
            ),
            self.client.put(
                "/api/stats/2026-07-17",
                json={"poms": 1, "note": "forbidden"},
                headers={"X-CSRF-Token": token},
            ),
            self.client.post(
                "/api/import",
                json={"data": {"tasks": {}, "poms": {}, "notes": {}}},
                headers={"X-CSRF-Token": token},
            ),
            self.client.get("/api/export"),
            self.client.post(
                "/api/stages",
                json={"title": "forbidden", "description": "forbidden"},
                headers={"X-CSRF-Token": token},
            ),
            self.client.put(
                "/api/stages/1",
                json={"title": "forbidden"},
                headers={"X-CSRF-Token": token},
            ),
            self.client.post(
                "/api/stages/1/complete",
                json={"proofText": "forbidden"},
                headers={"X-CSRF-Token": token},
            ),
        ]
        for response in attempts:
            self.assertEqual(response.status_code, 403, response.get_data(as_text=True))
            self.assertEqual(response.get_json()["code"], "read_only")
        with self.db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM task_progress").fetchone()[0], 0)
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM task_progress_assets").fetchone()[0],
                0,
            )
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM daily_stats").fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM stages").fetchone()[0], 0)

    def test_owner_task_stats_proof_image_and_export_flow(self):
        self.login_unlocked_owner()
        created = self.put_task(
            self.client,
            task_date="2026-07-17",
            text="25-50 B(2) triangles and solid geometry",
        )
        self.assertEqual(created.status_code, 200)
        self.assertFalse(created.get_json()["task"]["done"])

        stats = self.client.put(
            "/api/stats/2026-07-17",
            json={
                "poms": 4,
                "note": "Focused session",
                "distractions": "Checked messages once",
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(stats.status_code, 200)
        self.assertEqual(
            stats.get_json()["stats"],
            {
                "poms": 4,
                "note": "Focused session",
                "distractions": "Checked messages once",
            },
        )

        completed = self.client.post(
            "/api/tasks/2026-07-17/complete",
            data={
                "proofText": "All exercises checked",
                "image": (io.BytesIO(self.png_bytes()), "proof.png"),
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
        task = completed.get_json()["task"]
        self.assertTrue(task["done"])
        self.assertEqual(task["proofText"], "All exercises checked")
        self.assertEqual(task["proofUrl"], "")
        self.assertRegex(task["proofImageUrl"], r"^/api/proofs/[a-f0-9]{32}\.jpg$")
        self.assertEqual(task["proofFileUrl"], task["proofImageUrl"])
        self.assertEqual(task["proofFileName"], "proof.png")
        self.assertEqual(task["proofFileMime"], "image/jpeg")
        self.assertGreater(task["proofFileSize"], 0)

        proof = self.client.get(task["proofImageUrl"])
        self.assertEqual(proof.status_code, 200)
        self.assertEqual(proof.content_type, "image/jpeg")
        self.assertIn("inline", proof.headers["Content-Disposition"])
        self.assertEqual(int(proof.headers["Content-Length"]), task["proofFileSize"])
        with server.Image.open(io.BytesIO(proof.data)) as decoded:
            self.assertEqual(decoded.format, "JPEG")
            self.assertEqual(decoded.mode, "RGB")
            self.assertLessEqual(decoded.width, 2400)
            self.assertLessEqual(decoded.height, 2400)
        proof.close()

        payload = self.client.get("/api/data").get_json()
        self.assertEqual(
            payload["stats"]["2026-07-17"],
            {
                "poms": 4,
                "note": "Focused session",
                "distractions": "Checked messages once",
            },
        )
        self.assertEqual(payload["publicPoms"], {"2026-07-17": 4})
        self.assertEqual(payload["tasks"][0]["proofImageUrl"], task["proofImageUrl"])

        cannot_edit = self.put_task(self.client, text="rewrite completed task")
        self.assertEqual(cannot_edit.status_code, 409)
        cannot_delete = self.client.delete(
            "/api/tasks/2026-07-17",
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(cannot_delete.status_code, 409)

        exported = self.client.get("/api/export")
        self.assertEqual(exported.status_code, 200)
        self.assertIn("attachment; filename=", exported.headers["Content-Disposition"])
        export_data = json.loads(exported.get_data(as_text=True))
        self.assertTrue(export_data["tasks"]["2026-07-17"]["done"])
        self.assertEqual(
            export_data["tasks"]["2026-07-17"]["proofFileName"], "proof.png"
        )
        self.assertEqual(
            export_data["tasks"]["2026-07-17"]["proofFileMime"], "image/jpeg"
        )
        self.assertEqual(export_data["poms"]["2026-07-17"], 4)
        self.assertEqual(export_data["notes"]["2026-07-17"], "Focused session")
        self.assertEqual(
            export_data["distractions"]["2026-07-17"], "Checked messages once"
        )

    def test_owner_can_record_completed_and_incomplete_daily_results(self):
        self.login_unlocked_owner()

        self.assertEqual(
            self.put_task(
                self.client,
                task_date="2026-07-20",
                text="Finish the complete target",
            ).status_code,
            200,
        )
        completed = self.client.post(
            "/api/tasks/2026-07-20/result",
            data={
                "resultStatus": "completed",
                "completionPercent": "100",
                "resultNote": "All planned work was checked.",
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
        completed_task = completed.get_json()["task"]
        self.assertTrue(completed_task["done"])
        self.assertEqual(completed_task["resultStatus"], "completed")
        self.assertEqual(completed_task["completionPercent"], 100)
        self.assertEqual(completed_task["resultNote"], "All planned work was checked.")
        self.assertIsNotNone(completed_task["resultRecordedAt"])
        self.assertIsNotNone(completed_task["completedAt"])

        self.assertEqual(
            self.put_task(
                self.client,
                task_date="2026-07-21",
                text="Attempt the partial target",
            ).status_code,
            200,
        )
        incomplete = self.client.post(
            "/api/tasks/2026-07-21/result",
            data={
                "resultStatus": "incomplete",
                "completionPercent": "63",
                "resultNote": "Stopped after the solid-geometry section took longer.",
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(incomplete.status_code, 200, incomplete.get_data(as_text=True))
        incomplete_task = incomplete.get_json()["task"]
        self.assertFalse(incomplete_task["done"])
        self.assertEqual(incomplete_task["resultStatus"], "incomplete")
        self.assertEqual(incomplete_task["completionPercent"], 63)
        self.assertEqual(
            incomplete_task["resultNote"],
            "Stopped after the solid-geometry section took longer.",
        )
        self.assertIsNotNone(incomplete_task["resultRecordedAt"])
        self.assertIsNone(incomplete_task["completedAt"])

        tasks = {
            item["date"]: item for item in self.client.get("/api/data").get_json()["tasks"]
        }
        self.assertEqual(tasks["2026-07-20"]["resultStatus"], "completed")
        self.assertEqual(tasks["2026-07-21"]["resultStatus"], "incomplete")

        cannot_edit = self.put_task(
            self.client,
            task_date="2026-07-21",
            text="must stay locked",
        )
        self.assertEqual(cannot_edit.status_code, 409)
        self.assertEqual(cannot_edit.get_json()["code"], "task_recorded")
        cannot_delete = self.client.delete(
            "/api/tasks/2026-07-21",
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(cannot_delete.status_code, 409)
        self.assertEqual(cannot_delete.get_json()["code"], "task_recorded")

    def test_daily_result_validation_rejects_invalid_or_missing_feedback(self):
        self.login_unlocked_owner()
        task_date = "2026-07-22"
        self.assertEqual(
            self.put_task(self.client, task_date=task_date, text="Validate result input").status_code,
            200,
        )
        cases = [
            (
                "missing status",
                {"completionPercent": "50", "resultNote": "reason"},
                "invalid_result_status",
            ),
            (
                "pending is not final",
                {
                    "resultStatus": "pending",
                    "completionPercent": "0",
                    "resultNote": "reason",
                },
                "invalid_result_status",
            ),
            (
                "missing percent",
                {"resultStatus": "completed", "resultNote": "done"},
                "invalid_completion_percent",
            ),
            (
                "completed below one hundred",
                {
                    "resultStatus": "completed",
                    "completionPercent": "99",
                    "resultNote": "done",
                },
                "invalid_completion_percent",
            ),
            (
                "incomplete at one hundred",
                {
                    "resultStatus": "incomplete",
                    "completionPercent": "100",
                    "resultNote": "reason",
                },
                "invalid_completion_percent",
            ),
            (
                "fractional percent",
                {
                    "resultStatus": "incomplete",
                    "completionPercent": "42.5",
                    "resultNote": "reason",
                },
                "invalid_completion_percent",
            ),
            (
                "completed note required",
                {
                    "resultStatus": "completed",
                    "completionPercent": "100",
                    "resultNote": "   ",
                },
                "result_note_required",
            ),
            (
                "incomplete reason required",
                {"resultStatus": "incomplete", "completionPercent": "42"},
                "result_note_required",
            ),
        ]
        for label, data, expected_code in cases:
            with self.subTest(label=label):
                response = self.client.post(
                    f"/api/tasks/{task_date}/result",
                    data=data,
                    headers={"X-CSRF-Token": self.csrf()},
                )
                self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
                self.assertEqual(response.get_json()["code"], expected_code)

        task = self.client.get("/api/data").get_json()["tasks"][0]
        self.assertFalse(task["done"])
        self.assertEqual(task["resultStatus"], "pending")
        self.assertEqual(task["completionPercent"], 0)
        self.assertEqual(task["resultNote"], "")
        self.assertIsNone(task["resultRecordedAt"])

    def test_viewer_sees_public_daily_feedback_but_not_owner_private_notes(self):
        owner_client = server.app.test_client()
        self.login_unlocked_owner(owner_client)
        task_date = server.business_today_key()
        public_reason = "Completed 70%; the final proof review needs another session."
        private_note = "Private note: reschedule the next study block."
        private_distraction = "Private distraction: checked a message."
        self.assertEqual(
            self.put_task(owner_client, task_date=task_date, text="Public daily target").status_code,
            200,
        )
        self.assertEqual(
            owner_client.put(
                f"/api/stats/{task_date}",
                json={
                    "poms": 3,
                    "note": private_note,
                    "distractions": private_distraction,
                },
                headers={"X-CSRF-Token": self.csrf(owner_client)},
            ).status_code,
            200,
        )
        recorded = owner_client.post(
            f"/api/tasks/{task_date}/result",
            data={
                "resultStatus": "incomplete",
                "completionPercent": "70",
                "resultNote": public_reason,
            },
            headers={"X-CSRF-Token": self.csrf(owner_client)},
        )
        self.assertEqual(recorded.status_code, 200, recorded.get_data(as_text=True))

        viewer_client = server.app.test_client()
        self.assertEqual(self.register_viewer(viewer_client).status_code, 200)
        response = viewer_client.get("/api/data")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertNotIn("stats", payload)
        task = next(item for item in payload["tasks"] if item["date"] == task_date)
        self.assertFalse(task["done"])
        self.assertEqual(task["resultStatus"], "incomplete")
        self.assertEqual(task["completionPercent"], 70)
        self.assertEqual(task["resultNote"], public_reason)
        self.assertIsNotNone(task["resultRecordedAt"])

        raw_payload = response.get_data(as_text=True)
        self.assertIn(public_reason, raw_payload)
        self.assertNotIn(private_note, raw_payload)
        self.assertNotIn(private_distraction, raw_payload)

    def test_daily_result_fields_round_trip_through_import_and_export(self):
        self.login_unlocked_owner()
        imported = self.client.post(
            "/api/import",
            json={
                "data": {
                    "tasks": {
                        "2026-07-23": {
                            "text": "Imported partial target",
                            "done": False,
                            "resultStatus": "incomplete",
                            "completionPercent": 48,
                            "resultNote": "Imported reason stays public.",
                        }
                    },
                    "poms": {},
                    "notes": {},
                    "distractions": {},
                }
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(imported.status_code, 200, imported.get_data(as_text=True))
        self.assertEqual(imported.get_json()["importedTasks"], 1)

        task = self.client.get("/api/data").get_json()["tasks"][0]
        self.assertFalse(task["done"])
        self.assertEqual(task["resultStatus"], "incomplete")
        self.assertEqual(task["completionPercent"], 48)
        self.assertEqual(task["resultNote"], "Imported reason stays public.")
        self.assertIsNotNone(task["resultRecordedAt"])

        exported = self.client.get("/api/export")
        self.assertEqual(exported.status_code, 200)
        exported_task = json.loads(exported.get_data(as_text=True))["tasks"]["2026-07-23"]
        self.assertFalse(exported_task["done"])
        self.assertEqual(exported_task["resultStatus"], "incomplete")
        self.assertEqual(exported_task["completionPercent"], 48)
        self.assertEqual(exported_task["resultNote"], "Imported reason stays public.")
        self.assertIsNotNone(exported_task["resultRecordedAt"])

    def test_later_progress_marks_final_result_stale_until_result_is_reconfirmed(self):
        self.login_unlocked_owner()
        task_date = server.business_today_key()
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        token = self.csrf()
        base_time = server.now_ts()
        with patch.object(server, "now_ts", return_value=base_time + 10):
            first_progress = self.client.post(
                f"/api/tasks/{task_date}/progress",
                json={
                    "note": "First checkpoint",
                    "progressPercent": 50,
                    "links": [],
                },
                headers={"X-CSRF-Token": token},
            )
        self.assertEqual(first_progress.status_code, 201, first_progress.get_data(as_text=True))
        with patch.object(server, "now_ts", return_value=base_time + 20):
            first_result = self.client.post(
                f"/api/tasks/{task_date}/result",
                data={
                    "resultStatus": "incomplete",
                    "completionPercent": "60",
                    "resultNote": "First final note remains visible.",
                },
                headers={"X-CSRF-Token": token},
            )
        self.assertEqual(first_result.status_code, 200, first_result.get_data(as_text=True))
        self.assertFalse(first_result.get_json()["task"]["resultIsStale"])

        # A checkpoint created after the result in the very same wall-clock
        # second must still make that result stale.
        with patch.object(server, "now_ts", return_value=base_time + 20):
            later_progress = self.client.post(
                f"/api/tasks/{task_date}/progress",
                json={
                    "note": "Work continued after the result",
                    "progressPercent": 80,
                    "links": [],
                },
                headers={"X-CSRF-Token": token},
            )
        self.assertEqual(later_progress.status_code, 201, later_progress.get_data(as_text=True))
        stale_task = later_progress.get_json()["task"]
        self.assertTrue(stale_task["resultIsStale"])
        self.assertEqual(stale_task["resultNote"], "First final note remains visible.")
        owner_task = next(
            task
            for task in self.client.get("/api/data").get_json()["tasks"]
            if task["date"] == task_date
        )
        self.assertTrue(owner_task["resultIsStale"])
        self.assertEqual(owner_task["resultNote"], "First final note remains visible.")
        exported_task = json.loads(
            self.client.get("/api/export").get_data(as_text=True)
        )["tasks"][task_date]
        self.assertTrue(exported_task["resultIsStale"])

        viewer = server.app.test_client()
        self.assertEqual(self.register_viewer(viewer).status_code, 200)
        viewer_task = next(
            task
            for task in viewer.get("/api/data").get_json()["tasks"]
            if task["date"] == task_date
        )
        self.assertTrue(viewer_task["resultIsStale"])
        self.assertEqual(viewer_task["resultNote"], "First final note remains visible.")

        with patch.object(server, "now_ts", return_value=base_time + 20):
            reconfirmed = self.client.post(
                f"/api/tasks/{task_date}/result",
                data={
                    "resultStatus": "incomplete",
                    "completionPercent": "85",
                    "resultNote": "Reconfirmed after the later checkpoint.",
                },
                headers={"X-CSRF-Token": token},
            )
        self.assertEqual(reconfirmed.status_code, 200, reconfirmed.get_data(as_text=True))
        self.assertFalse(reconfirmed.get_json()["task"]["resultIsStale"])
        self.assertEqual(
            reconfirmed.get_json()["task"]["resultNote"],
            "Reconfirmed after the later checkpoint.",
        )

    def test_concurrent_same_second_result_writes_use_version_compare_and_swap(self):
        client_a = server.app.test_client()
        client_b = server.app.test_client()
        self.login_unlocked_owner(client_a)
        self.login_unlocked_owner(client_b)
        task_date = "2026-07-22"
        self.assertEqual(self.put_task(client_a, task_date=task_date).status_code, 200)
        csrf_a = self.csrf(client_a)
        csrf_b = self.csrf(client_b)
        original_process = server.process_proof_attachment
        ready = threading.Barrier(2)

        def synchronized_process(upload):
            attachment = original_process(upload)
            ready.wait(timeout=10)
            return attachment

        responses = [None, None]

        def write_result(index, client, csrf_token, note):
            responses[index] = client.post(
                f"/api/tasks/{task_date}/result",
                data={
                    "resultStatus": "incomplete",
                    "completionPercent": "50",
                    "resultNote": note,
                },
                headers={"X-CSRF-Token": csrf_token},
            )

        # Both requests read result_version=0 before either takes the write
        # lock; exactly one may advance it to 1.
        same_time = server.now_ts()
        with (
            patch.object(server, "now_ts", return_value=same_time),
            patch.object(
                server,
                "process_proof_attachment",
                side_effect=synchronized_process,
            ),
        ):
            threads = [
                threading.Thread(
                    target=write_result,
                    args=(0, client_a, csrf_a, "Concurrent result A"),
                ),
                threading.Thread(
                    target=write_result,
                    args=(1, client_b, csrf_b, "Concurrent result B"),
                ),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=20)
                self.assertFalse(thread.is_alive())

        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        conflict = next(response for response in responses if response.status_code == 409)
        self.assertEqual(conflict.get_json()["code"], "proof_conflict")
        winner_note = next(
            response.get_json()["task"]["resultNote"]
            for response in responses
            if response.status_code == 200
        )
        with self.db() as connection:
            stored = connection.execute(
                "SELECT result_note, result_version, result_confirmed_progress_id "
                "FROM tasks WHERE task_date = ?",
                (task_date,),
            ).fetchone()
        self.assertEqual(stored["result_note"], winner_note)
        self.assertEqual(stored["result_version"], 1)
        self.assertEqual(stored["result_confirmed_progress_id"], 0)

    def test_progress_entries_append_in_order_without_overwriting_the_daily_result(self):
        self.login_unlocked_owner()
        task_date = "2026-07-24"
        self.assertEqual(
            self.put_task(self.client, task_date=task_date, text="Work through the plan in blocks").status_code,
            200,
        )
        first_time = server.now_ts() + 5
        first_links = [
            "https://drive.google.com/file/d/morning-one/view",
            "https://example.test/morning-summary",
        ]
        with patch.object(server, "now_ts", return_value=first_time):
            first_response = self.create_progress(
                task_date=task_date,
                note="上午完成三角形的第一部分。",
                progress_percent=30,
                links=first_links,
            )
        self.assertEqual(first_response.status_code, 201, first_response.get_data(as_text=True))
        first = first_response.get_json()["progress"]
        self.assertEqual(first["note"], "上午完成三角形的第一部分。")
        self.assertEqual(first["progressPercent"], 30)
        self.assertEqual(first["createdAt"], server.utc_iso(first_time))
        self.assertEqual(
            [(asset["kind"], asset["url"]) for asset in first["assets"]],
            [("link", link) for link in first_links],
        )
        first_snapshot = json.loads(json.dumps(first, ensure_ascii=False))

        # More than a typical compact UI fold threshold proves that links are
        # not constrained to one field or an arbitrary low item count.
        later_links = [f"https://example.test/afternoon/{index}" for index in range(12)]
        second_time = first_time + 90
        with patch.object(server, "now_ts", return_value=second_time):
            second_response = self.create_progress(
                task_date=task_date,
                note="下午补完立体几何例题，晚上还会继续。",
                progress_percent=68,
                links=later_links,
            )
        self.assertEqual(second_response.status_code, 201, second_response.get_data(as_text=True))
        payload = second_response.get_json()
        second = payload["progress"]
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(second["createdAt"], server.utc_iso(second_time))
        self.assertEqual([asset["url"] for asset in second["assets"]], later_links)

        task = payload["task"]
        self.assertEqual(task["resultStatus"], "pending")
        self.assertFalse(task["done"])
        self.assertEqual(task["resultNote"], "")
        self.assertIsNone(task["resultRecordedAt"])
        self.assertEqual([entry["id"] for entry in task["progressEntries"]], [first["id"], second["id"]])
        self.assertEqual(task["progressEntries"][0], first_snapshot)

        stored = self.client.get("/api/data").get_json()["tasks"][0]
        self.assertEqual(stored["progressEntries"], task["progressEntries"])
        with self.db() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM task_progress WHERE task_date = ?", (task_date,)
                ).fetchone()[0],
                2,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM task_progress_assets WHERE kind = 'link'"
                ).fetchone()[0],
                len(first_links) + len(later_links),
            )

    def test_progress_entries_created_in_the_same_second_keep_numeric_id_order(self):
        self.login_unlocked_owner()
        task_date = "2026-07-31"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        shared_time = server.now_ts() + 10
        created_ids = []
        with patch.object(server, "now_ts", return_value=shared_time):
            for index in range(12):
                response = self.create_progress(
                    task_date=task_date,
                    note=f"same-second-{index}",
                    progress_percent=index,
                )
                self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
                created_ids.append(response.get_json()["progress"]["id"])

        task = next(
            item
            for item in self.client.get("/api/data").get_json()["tasks"]
            if item["date"] == task_date
        )
        self.assertEqual([entry["id"] for entry in task["progressEntries"]], created_ids)
        self.assertEqual(
            [entry["note"] for entry in task["progressEntries"]],
            [f"same-second-{index}" for index in range(12)],
        )
        self.assertEqual(
            {entry["createdAt"] for entry in task["progressEntries"]},
            {server.utc_iso(shared_time)},
        )

    def test_progress_files_upload_sequentially_and_never_duplicate_existing_assets(self):
        self.login_unlocked_owner()
        task_date = "2026-07-25"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        created = self.create_progress(
            task_date=task_date,
            note="第一轮材料",
            progress_percent=40,
            links=["https://example.test/plan"],
        )
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        progress_id = created.get_json()["progress"]["id"]
        samples = [
            (self.png_bytes(), "morning.png", "image/jpeg"),
            (self.pdf_bytes(), "worksheet.pdf", "application/pdf"),
            ("下午总结".encode(), "summary.txt", "text/plain"),
        ]
        known_file_ids = []
        known_file_urls = []
        for index, (raw, name, expected_mime) in enumerate(samples, start=1):
            before_files = set(server.UPLOAD_DIR.iterdir())
            uploaded = self.upload_progress_file(
                progress_id,
                raw,
                name,
                task_date=task_date,
            )
            self.assertEqual(uploaded.status_code, 201, uploaded.get_data(as_text=True))
            progress = uploaded.get_json()["progress"]
            file_assets = [asset for asset in progress["assets"] if asset["kind"] == "file"]
            self.assertEqual(len(file_assets), index)
            self.assertEqual(
                [asset["id"] for asset in file_assets[:-1]],
                known_file_ids,
                "adding a file must keep, not copy or replace, earlier assets",
            )
            self.assertEqual(
                [asset["proofFileUrl"] for asset in file_assets[:-1]],
                known_file_urls,
            )
            newest = file_assets[-1]
            self.assertEqual(newest["proofFileName"], name)
            self.assertEqual(newest["proofFileMime"], expected_mime)
            self.assertIsNotNone(newest["createdAt"])
            known_file_ids.append(newest["id"])
            known_file_urls.append(newest["proofFileUrl"])
            after_files = set(server.UPLOAD_DIR.iterdir())
            self.assertEqual(len(after_files - before_files), 1)
            self.assertTrue(before_files.issubset(after_files))

        final_progress = uploaded.get_json()["progress"]
        self.assertEqual(len(final_progress["assets"]), 4)
        self.assertEqual(final_progress["assets"][0]["kind"], "link")
        for url, (_, raw_name, expected_mime) in zip(known_file_urls, samples):
            downloaded = self.client.get(url)
            self.assertEqual(downloaded.status_code, 200, raw_name)
            self.assertEqual(downloaded.mimetype, expected_mime)
            downloaded.close()

        # The transport accepts exactly one file per request. The browser can
        # choose many, but sends these requests sequentially in the background.
        before_rejected = set(server.UPLOAD_DIR.iterdir())
        rejected = self.client.post(
            f"/api/tasks/{task_date}/progress/{progress_id}/files",
            data={
                "attachment": [
                    (io.BytesIO(b"one"), "one.txt"),
                    (io.BytesIO(b"two"), "two.txt"),
                ]
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(rejected.get_json()["code"], "multiple_attachments")
        self.assertEqual(set(server.UPLOAD_DIR.iterdir()), before_rejected)

    def test_progress_and_file_retry_tokens_prevent_duplicate_storage(self):
        self.login_unlocked_owner()
        task_date = "2026-08-02"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        progress_token = "progress-retry-token-0001"
        request_body = {
            "note": "A request whose response may be lost",
            "progressPercent": 42,
            "links": ["https://example.test/retry"],
            "clientRecordId": progress_token,
        }
        first = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json=request_body,
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(first.status_code, 201, first.get_data(as_text=True))
        retried = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json=request_body,
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(retried.status_code, 200, retried.get_data(as_text=True))
        self.assertTrue(retried.get_json()["idempotent"])
        progress_id = first.get_json()["progress"]["id"]
        self.assertEqual(retried.get_json()["progress"]["id"], progress_id)

        upload_token = "upload-retry-token-000001"
        upload = lambda raw: self.client.post(
            f"/api/tasks/{task_date}/progress/{progress_id}/files",
            data={
                "attachment": (io.BytesIO(raw), "retry.txt"),
                "clientUploadId": upload_token,
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        first_upload = upload(b"stored once")
        self.assertEqual(first_upload.status_code, 201, first_upload.get_data(as_text=True))
        files_after_first = set(server.UPLOAD_DIR.iterdir())
        retried_upload = upload(b"must not create a second physical file")
        self.assertEqual(retried_upload.status_code, 200, retried_upload.get_data(as_text=True))
        self.assertTrue(retried_upload.get_json()["idempotent"])
        self.assertEqual(
            retried_upload.get_json()["asset"]["id"],
            first_upload.get_json()["asset"]["id"],
        )
        self.assertEqual(set(server.UPLOAD_DIR.iterdir()), files_after_first)
        with self.db() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM task_progress WHERE task_date = ?", (task_date,)
                ).fetchone()[0],
                1,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM task_progress_assets WHERE progress_id = ?",
                    (progress_id,),
                ).fetchone()[0],
                2,
            )

    def test_empty_unchanged_progress_is_rejected_after_idempotency_recheck(self):
        self.login_unlocked_owner()
        task_date = "2026-08-04"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        token = self.csrf()
        empty = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json={"note": "", "progressPercent": 0, "links": []},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(empty.status_code, 400, empty.get_data(as_text=True))
        self.assertEqual(empty.get_json()["code"], "no_progress_change")
        explicit_false = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json={
                "note": "",
                "progressPercent": 0,
                "links": [],
                "hasPendingFiles": False,
            },
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(
            explicit_false.status_code, 400, explicit_false.get_data(as_text=True)
        )
        self.assertEqual(explicit_false.get_json()["code"], "no_progress_change")
        invalid_pending_files = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json={
                "note": "",
                "progressPercent": 0,
                "links": [],
                "hasPendingFiles": "yes",
            },
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(
            invalid_pending_files.status_code,
            400,
            invalid_pending_files.get_data(as_text=True),
        )
        self.assertEqual(
            invalid_pending_files.get_json()["code"], "invalid_pending_files"
        )

        file_only_body = {
            "note": "",
            "progressPercent": 0,
            "links": [],
            "hasPendingFiles": True,
            "clientRecordId": "file-only-progress-token-0001",
        }
        file_only = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json=file_only_body,
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(file_only.status_code, 201, file_only.get_data(as_text=True))
        file_only_retry = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json={**file_only_body, "hasPendingFiles": False},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(
            file_only_retry.status_code, 200, file_only_retry.get_data(as_text=True)
        )
        self.assertTrue(file_only_retry.get_json()["idempotent"])
        self.assertEqual(
            file_only_retry.get_json()["progress"]["id"],
            file_only.get_json()["progress"]["id"],
        )

        request_body = {
            "note": "",
            "progressPercent": 25,
            "links": [],
            "clientRecordId": "progress-change-token-000001",
        }
        changed = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json=request_body,
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(changed.status_code, 201, changed.get_data(as_text=True))
        retried = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json=request_body,
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(retried.status_code, 200, retried.get_data(as_text=True))
        self.assertTrue(retried.get_json()["idempotent"])
        self.assertEqual(
            retried.get_json()["progress"]["id"],
            changed.get_json()["progress"]["id"],
        )

        repeated_percent = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json={"note": "", "progressPercent": 25, "links": []},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(
            repeated_percent.status_code, 400, repeated_percent.get_data(as_text=True)
        )
        self.assertEqual(repeated_percent.get_json()["code"], "no_progress_change")
        note_only = self.client.post(
            f"/api/tasks/{task_date}/progress",
            json={"note": "Same percent, new observation", "progressPercent": 25, "links": []},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(note_only.status_code, 201, note_only.get_data(as_text=True))
        with self.db() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM task_progress WHERE task_date = ?", (task_date,)
                ).fetchone()[0],
                3,
            )

    def test_concurrent_retry_tokens_return_one_progress_and_one_physical_file(self):
        client_a = server.app.test_client()
        client_b = server.app.test_client()
        self.login_unlocked_owner(client_a)
        self.login_unlocked_owner(client_b)
        task_date = "2026-08-03"
        self.assertEqual(self.put_task(client_a, task_date=task_date).status_code, 200)
        csrf_a = self.csrf(client_a)
        csrf_b = self.csrf(client_b)
        progress_token = "concurrent-progress-token-0001"
        request_body = {
            "note": "Concurrent retry",
            "progressPercent": 45,
            "links": [],
            "clientRecordId": progress_token,
        }
        start = threading.Barrier(2)
        responses = [None, None]

        def post_progress(index, client, csrf_token):
            start.wait(timeout=10)
            responses[index] = client.post(
                f"/api/tasks/{task_date}/progress",
                json=request_body,
                headers={"X-CSRF-Token": csrf_token},
            )

        threads = [
            threading.Thread(target=post_progress, args=(0, client_a, csrf_a)),
            threading.Thread(target=post_progress, args=(1, client_b, csrf_b)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)
            self.assertFalse(thread.is_alive())
        self.assertEqual(sorted(response.status_code for response in responses), [200, 201])
        progress_ids = {response.get_json()["progress"]["id"] for response in responses}
        self.assertEqual(len(progress_ids), 1)
        progress_id = progress_ids.pop()

        # Force both requests past validation and physical staging before
        # either reaches BEGIN IMMEDIATE. The losing retry must remove only its
        # own staged file and return the winning asset.
        original_process = server.process_proof_attachment
        file_barrier = threading.Barrier(2)

        def synchronized_process(upload):
            attachment = original_process(upload)
            file_barrier.wait(timeout=10)
            return attachment

        file_responses = [None, None]
        upload_token = "concurrent-upload-token-000001"

        def post_file(index, client, csrf_token, raw):
            file_responses[index] = client.post(
                f"/api/tasks/{task_date}/progress/{progress_id}/files",
                data={
                    "attachment": (io.BytesIO(raw), "concurrent.txt"),
                    "clientUploadId": upload_token,
                },
                headers={"X-CSRF-Token": csrf_token},
            )

        with patch.object(server, "process_proof_attachment", side_effect=synchronized_process):
            file_threads = [
                threading.Thread(
                    target=post_file,
                    args=(0, client_a, csrf_a, b"winner candidate a"),
                ),
                threading.Thread(
                    target=post_file,
                    args=(1, client_b, csrf_b, b"winner candidate b"),
                ),
            ]
            for thread in file_threads:
                thread.start()
            for thread in file_threads:
                thread.join(timeout=20)
                self.assertFalse(thread.is_alive())

        self.assertEqual(
            sorted(response.status_code for response in file_responses), [200, 201]
        )
        asset_ids = {response.get_json()["asset"]["id"] for response in file_responses}
        self.assertEqual(len(asset_ids), 1)
        self.assertEqual(len(list(server.UPLOAD_DIR.iterdir())), 1)
        with self.db() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM task_progress WHERE task_date = ?", (task_date,)
                ).fetchone()[0],
                1,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM task_progress_assets "
                    "WHERE progress_id = ? AND kind = 'file'",
                    (progress_id,),
                ).fetchone()[0],
                1,
            )

    def test_each_progress_file_has_an_independent_exact_10_mib_limit(self):
        self.login_unlocked_owner()
        task_date = "2026-07-26"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        progress = self.create_progress(
            task_date=task_date,
            note="Large evidence boundary",
            progress_percent=50,
        ).get_json()["progress"]

        exact = b"a" * (10 * 1024 * 1024)
        accepted = self.upload_progress_file(
            progress["id"], exact, "exact.txt", task_date=task_date
        )
        self.assertEqual(accepted.status_code, 201, accepted.get_data(as_text=True))
        accepted_asset = next(
            asset
            for asset in accepted.get_json()["progress"]["assets"]
            if asset["kind"] == "file"
        )
        self.assertEqual(accepted_asset["proofFileSize"], 10 * 1024 * 1024)
        files_after_exact = set(server.UPLOAD_DIR.iterdir())
        self.assertEqual(len(files_after_exact), 1)

        rejected = self.upload_progress_file(
            progress["id"], exact + b"b", "too-large.txt", task_date=task_date
        )
        self.assertEqual(rejected.status_code, 413, rejected.get_data(as_text=True))
        self.assertEqual(rejected.get_json()["code"], "attachment_too_large")
        self.assertEqual(set(server.UPLOAD_DIR.iterdir()), files_after_exact)
        with self.db() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM task_progress_assets WHERE progress_id = ? AND kind = 'file'",
                    (progress["id"],),
                ).fetchone()[0],
                1,
            )

    def test_viewer_sees_public_progress_assets_but_not_future_progress(self):
        owner = server.app.test_client()
        self.login_unlocked_owner(owner)
        today = "2026-07-27"
        future = "2026-07-28"
        for task_date in (today, future):
            self.assertEqual(self.put_task(owner, task_date=task_date).status_code, 200)
        current_progress = self.create_progress(
            owner,
            task_date=today,
            note="今天公开的进度备注",
            progress_percent=45,
            links=["https://example.test/today-a", "https://example.test/today-b"],
        ).get_json()["progress"]
        current_file = self.upload_progress_file(
            current_progress["id"],
            self.pdf_bytes(),
            "today.pdf",
            client=owner,
            task_date=today,
        ).get_json()["progress"]
        current_file_url = next(
            asset["proofFileUrl"] for asset in current_file["assets"] if asset["kind"] == "file"
        )
        future_progress = self.create_progress(
            owner,
            task_date=future,
            note="future progress must stay hidden",
            progress_percent=20,
            links=["https://example.test/future"],
        ).get_json()["progress"]
        future_file = self.upload_progress_file(
            future_progress["id"],
            b"future evidence",
            "future.txt",
            client=owner,
            task_date=future,
        ).get_json()["progress"]
        future_file_url = next(
            asset["proofFileUrl"] for asset in future_file["assets"] if asset["kind"] == "file"
        )

        viewer = server.app.test_client()
        self.assertEqual(self.register_viewer(viewer).status_code, 200)
        with patch.object(server, "business_today_key", return_value=today):
            response = viewer.get("/api/data")
            self.assertEqual(response.status_code, 200)
            tasks = {task["date"]: task for task in response.get_json()["tasks"]}
            self.assertEqual(set(tasks), {today})
            self.assertEqual(tasks[today]["resultStatus"], "pending")
            self.assertEqual(tasks[today]["progressEntries"][0]["note"], "今天公开的进度备注")
            self.assertEqual(len(tasks[today]["progressEntries"][0]["assets"]), 3)
            visible = viewer.get(current_file_url)
            hidden = viewer.get(future_file_url)
        self.assertEqual(visible.status_code, 200)
        visible.close()
        self.assertEqual(hidden.status_code, 404)
        self.assertEqual(hidden.get_json()["code"], "not_found")
        self.assertNotIn("future progress must stay hidden", response.get_data(as_text=True))

    def test_shared_progress_file_is_visible_when_any_reference_date_is_visible(self):
        owner = server.app.test_client()
        self.login_unlocked_owner(owner)
        today = "2026-07-27"
        future = "2026-07-28"
        for task_date in (today, future):
            self.assertEqual(self.put_task(owner, task_date=task_date).status_code, 200)

        # Insert the future reference first so authorization cannot depend on
        # whichever matching row SQLite happens to return first.
        future_progress = self.create_progress(
            owner,
            task_date=future,
            note="Future reference created first",
            progress_percent=20,
        ).get_json()["progress"]
        shared_raw = b"one immutable file referenced by two dates"
        future_shared = self.upload_progress_file(
            future_progress["id"],
            shared_raw,
            "future-shared.txt",
            client=owner,
            task_date=future,
        ).get_json()["asset"]
        future_only = self.upload_progress_file(
            future_progress["id"],
            b"future only bytes",
            "future-only.txt",
            client=owner,
            task_date=future,
        ).get_json()["asset"]

        today_progress = self.create_progress(
            owner,
            task_date=today,
            note="Visible reference created second",
            progress_percent=40,
        ).get_json()["progress"]
        today_shared = self.upload_progress_file(
            today_progress["id"],
            shared_raw,
            "today-shared.txt",
            client=owner,
            task_date=today,
        ).get_json()["asset"]
        self.assertEqual(
            future_shared["proofFileUrl"], today_shared["proofFileUrl"]
        )
        self.assertEqual(len(list(server.UPLOAD_DIR.iterdir())), 2)

        viewer = server.app.test_client()
        self.assertEqual(self.register_viewer(viewer).status_code, 200)
        with patch.object(server, "business_today_key", return_value=today):
            visible_shared = viewer.get(today_shared["proofFileUrl"])
            hidden_future_only = viewer.get(future_only["proofFileUrl"])
        self.assertEqual(visible_shared.status_code, 200)
        visible_shared.close()
        self.assertEqual(hidden_future_only.status_code, 404)
        self.assertEqual(hidden_future_only.get_json()["code"], "not_found")

    def test_progress_timeline_and_asset_metadata_are_exported(self):
        self.login_unlocked_owner()
        task_date = "2026-07-29"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        first = self.create_progress(
            task_date=task_date,
            note="First checkpoint",
            progress_percent=25,
            links=["https://example.test/checkpoint/one"],
        ).get_json()["progress"]
        uploaded = self.upload_progress_file(
            first["id"], self.pdf_bytes(), "checkpoint.pdf", task_date=task_date
        )
        self.assertEqual(uploaded.status_code, 201, uploaded.get_data(as_text=True))
        self.assertEqual(
            self.create_progress(
                task_date=task_date,
                note="Second checkpoint",
                progress_percent=75,
                links=[
                    "https://example.test/checkpoint/two",
                    "https://example.test/checkpoint/three",
                ],
            ).status_code,
            201,
        )

        exported = self.client.get("/api/export")
        self.assertEqual(exported.status_code, 200)
        task = json.loads(exported.get_data(as_text=True))["tasks"][task_date]
        self.assertEqual(task["resultStatus"], "pending")
        self.assertEqual([entry["note"] for entry in task["progressEntries"]], [
            "First checkpoint",
            "Second checkpoint",
        ])
        self.assertEqual([entry["progressPercent"] for entry in task["progressEntries"]], [25, 75])
        first_assets = task["progressEntries"][0]["assets"]
        self.assertEqual([asset["kind"] for asset in first_assets], ["link", "file"])
        self.assertEqual(first_assets[0]["url"], "https://example.test/checkpoint/one")
        self.assertEqual(first_assets[1]["proofFileName"], "checkpoint.pdf")
        self.assertEqual(first_assets[1]["proofFileMime"], "application/pdf")
        self.assertGreater(first_assets[1]["proofFileSize"], 0)
        self.assertIsNotNone(first_assets[1]["createdAt"])

    def test_progress_text_and_links_round_trip_idempotently_while_files_are_reported(self):
        self.login_unlocked_owner()
        task_date = "2026-07-20"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        first = self.create_progress(
            task_date=task_date,
            note="Morning checkpoint",
            progress_percent=30,
            links=["https://example.test/morning"],
        ).get_json()["progress"]
        self.assertEqual(
            self.upload_progress_file(
                first["id"], self.pdf_bytes(), "morning.pdf", task_date=task_date
            ).status_code,
            201,
        )
        self.assertEqual(
            self.create_progress(
                task_date=task_date,
                note="Evening checkpoint",
                progress_percent=80,
                links=[
                    "https://example.test/evening/one",
                    "https://example.test/evening/two",
                ],
            ).status_code,
            201,
        )

        exported = json.loads(self.client.get("/api/export").get_data(as_text=True))
        self.assertEqual(exported["formatVersion"], 2)
        self.assertFalse(exported["attachmentsIncluded"])
        self.assertEqual(
            self.client.delete(
                f"/api/tasks/{task_date}",
                headers={"X-CSRF-Token": self.csrf()},
            ).status_code,
            200,
        )
        self.assertEqual(list(server.UPLOAD_DIR.iterdir()), [])

        first_import = self.client.post(
            "/api/import",
            json={"data": exported},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(first_import.status_code, 200, first_import.get_data(as_text=True))
        self.assertEqual(
            first_import.get_json(),
            {
                "ok": True,
                "importedTasks": 1,
                "importedProgressEntries": 2,
                "importedLinks": 3,
                "skippedAttachments": 1,
                "skippedMismatchedProgressEntries": 0,
            },
        )
        restored = next(
            task
            for task in self.client.get("/api/data").get_json()["tasks"]
            if task["date"] == task_date
        )
        self.assertEqual(
            [entry["note"] for entry in restored["progressEntries"]],
            ["Morning checkpoint", "Evening checkpoint"],
        )
        self.assertEqual(
            [asset["url"] for entry in restored["progressEntries"] for asset in entry["assets"]],
            [
                "https://example.test/morning",
                "https://example.test/evening/one",
                "https://example.test/evening/two",
            ],
        )
        self.assertFalse(
            any(
                asset["kind"] == "file"
                for entry in restored["progressEntries"]
                for asset in entry["assets"]
            )
        )

        repeated = self.client.post(
            "/api/import",
            json={"data": exported},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(repeated.status_code, 200, repeated.get_data(as_text=True))
        self.assertEqual(repeated.get_json()["importedTasks"], 0)
        self.assertEqual(repeated.get_json()["importedProgressEntries"], 0)
        self.assertEqual(repeated.get_json()["importedLinks"], 0)
        self.assertEqual(repeated.get_json()["skippedAttachments"], 1)
        with self.db() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM task_progress WHERE task_date = ?", (task_date,)
                ).fetchone()[0],
                2,
            )

    def test_export_import_preserves_stale_and_fresh_result_confirmation_positions(self):
        self.login_unlocked_owner()
        stale_date = "2026-07-23"
        fresh_date = "2026-07-24"
        token = self.csrf()
        same_time = server.now_ts() + 10
        for task_date in (stale_date, fresh_date):
            self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
            with patch.object(server, "now_ts", return_value=same_time):
                created = self.client.post(
                    f"/api/tasks/{task_date}/progress",
                    json={
                        "note": f"Initial progress {task_date}",
                        "progressPercent": 50,
                        "links": [],
                    },
                    headers={"X-CSRF-Token": token},
                )
                self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
                result = self.client.post(
                    f"/api/tasks/{task_date}/result",
                    data={
                        "resultStatus": "incomplete",
                        "completionPercent": "60",
                        "resultNote": f"Result for {task_date}",
                    },
                    headers={"X-CSRF-Token": token},
                )
                self.assertEqual(result.status_code, 200, result.get_data(as_text=True))
        with patch.object(server, "now_ts", return_value=same_time):
            later = self.client.post(
                f"/api/tasks/{stale_date}/progress",
                json={
                    "note": "Later progress in the same second",
                    "progressPercent": 75,
                    "links": [],
                },
                headers={"X-CSRF-Token": token},
            )
        self.assertEqual(later.status_code, 201, later.get_data(as_text=True))
        self.assertTrue(later.get_json()["task"]["resultIsStale"])

        exported = json.loads(self.client.get("/api/export").get_data(as_text=True))
        stale_export = exported["tasks"][stale_date]
        fresh_export = exported["tasks"][fresh_date]
        self.assertTrue(stale_export["resultIsStale"])
        self.assertFalse(fresh_export["resultIsStale"])
        self.assertEqual(stale_export["resultConfirmedProgressCount"], 1)
        self.assertEqual(fresh_export["resultConfirmedProgressCount"], 1)
        recorded_times = {
            stale_date: stale_export["resultRecordedAt"],
            fresh_date: fresh_export["resultRecordedAt"],
        }

        with self.db() as connection:
            connection.execute(
                "DELETE FROM task_progress_assets WHERE progress_id IN ("
                "SELECT id FROM task_progress WHERE task_date IN (?, ?)"
                ")",
                (stale_date, fresh_date),
            )
            connection.execute(
                "DELETE FROM task_progress WHERE task_date IN (?, ?)",
                (stale_date, fresh_date),
            )
            connection.execute(
                "DELETE FROM tasks WHERE task_date IN (?, ?)",
                (stale_date, fresh_date),
            )
        restored_response = self.client.post(
            "/api/import",
            json={"data": exported},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(
            restored_response.status_code,
            200,
            restored_response.get_data(as_text=True),
        )
        restored_tasks = {
            task["date"]: task for task in self.client.get("/api/data").get_json()["tasks"]
        }
        self.assertTrue(restored_tasks[stale_date]["resultIsStale"])
        self.assertFalse(restored_tasks[fresh_date]["resultIsStale"])
        self.assertEqual(
            restored_tasks[stale_date]["resultRecordedAt"], recorded_times[stale_date]
        )
        self.assertEqual(
            restored_tasks[fresh_date]["resultRecordedAt"], recorded_times[fresh_date]
        )
        self.assertEqual(
            restored_tasks[stale_date]["resultConfirmedProgressCount"], 1
        )
        self.assertEqual(
            restored_tasks[fresh_date]["resultConfirmedProgressCount"], 1
        )

    def test_progress_asset_and_task_deletion_remove_only_their_physical_files(self):
        self.login_unlocked_owner()
        task_date = "2026-07-30"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        progress = self.create_progress(
            task_date=task_date,
            note="Files that can be corrected",
            progress_percent=55,
            links=["https://example.test/keep-until-task-delete"],
        ).get_json()["progress"]
        first_upload = self.upload_progress_file(
            progress["id"], b"first attachment", "first.txt", task_date=task_date
        ).get_json()["progress"]
        first_asset = next(asset for asset in first_upload["assets"] if asset["kind"] == "file")
        first_path = server.UPLOAD_DIR / first_asset["proofFileUrl"].rsplit("/", 1)[-1]
        self.assertTrue(first_path.is_file())

        second_upload = self.upload_progress_file(
            progress["id"], self.pdf_bytes(), "second.pdf", task_date=task_date
        ).get_json()["progress"]
        file_assets = [asset for asset in second_upload["assets"] if asset["kind"] == "file"]
        self.assertEqual(file_assets[0]["id"], first_asset["id"])
        second_asset = file_assets[1]
        second_path = server.UPLOAD_DIR / second_asset["proofFileUrl"].rsplit("/", 1)[-1]
        self.assertEqual(set(server.UPLOAD_DIR.iterdir()), {first_path, second_path})

        deleted = self.client.delete(
            f"/api/tasks/{task_date}/progress/{progress['id']}/assets/{first_asset['id']}",
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertFalse(first_path.exists())
        self.assertTrue(second_path.exists())
        remaining = deleted.get_json()["progress"]["assets"]
        self.assertNotIn(first_asset["id"], {asset["id"] for asset in remaining})
        self.assertIn(second_asset["id"], {asset["id"] for asset in remaining})

        files_before_failure = set(server.UPLOAD_DIR.iterdir())
        original_get_db = server.get_db
        failure_token = self.csrf()

        class FailingProgressAssetDatabase:
            def __init__(self, database):
                self.database = database

            def execute(self, sql, parameters=()):
                if "INSERT INTO task_progress_assets" in sql:
                    raise sqlite3.OperationalError("forced progress asset failure")
                return self.database.execute(sql, parameters)

            def rollback(self):
                self.database.rollback()

            def __getattr__(self, name):
                return getattr(self.database, name)

        with patch.object(
            server,
            "get_db",
            side_effect=lambda: FailingProgressAssetDatabase(original_get_db()),
        ):
            with self.assertRaises(sqlite3.OperationalError):
                self.client.post(
                    f"/api/tasks/{task_date}/progress/{progress['id']}/files",
                    data={"attachment": (io.BytesIO(b"orphan candidate"), "failed.txt")},
                    headers={"X-CSRF-Token": failure_token},
                )
        self.assertEqual(set(server.UPLOAD_DIR.iterdir()), files_before_failure)

        removed_task = self.client.delete(
            f"/api/tasks/{task_date}",
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(removed_task.status_code, 200, removed_task.get_data(as_text=True))
        self.assertFalse(second_path.exists())
        self.assertEqual(list(server.UPLOAD_DIR.iterdir()), [])
        with self.db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM task_progress").fetchone()[0], 0)
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM task_progress_assets").fetchone()[0],
                0,
            )

    def test_identical_progress_uploads_share_disk_bytes_until_the_last_reference(self):
        self.login_unlocked_owner()
        task_date = "2026-07-21"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        first_progress = self.create_progress(
            task_date=task_date,
            note="First evidence checkpoint",
            progress_percent=40,
        ).get_json()["progress"]
        second_progress = self.create_progress(
            task_date=task_date,
            note="Second evidence checkpoint",
            progress_percent=60,
        ).get_json()["progress"]
        raw = b"the same immutable evidence bytes"
        first_response = self.upload_progress_file(
            first_progress["id"], raw, "first-name.txt", task_date=task_date
        )
        second_response = self.upload_progress_file(
            second_progress["id"], raw, "second-name.txt", task_date=task_date
        )
        self.assertEqual(first_response.status_code, 201, first_response.get_data(as_text=True))
        self.assertEqual(second_response.status_code, 201, second_response.get_data(as_text=True))
        first_asset = first_response.get_json()["asset"]
        second_asset = second_response.get_json()["asset"]
        self.assertNotEqual(first_asset["id"], second_asset["id"])
        self.assertEqual(first_asset["proofFileUrl"], second_asset["proofFileUrl"])
        self.assertEqual(first_asset["proofFileName"], "first-name.txt")
        self.assertEqual(second_asset["proofFileName"], "second-name.txt")
        self.assertEqual(len(list(server.UPLOAD_DIR.iterdir())), 1)
        shared_url = first_asset["proofFileUrl"]
        shared_path = server.UPLOAD_DIR / shared_url.rsplit("/", 1)[-1]

        # A failed attempt to add the same source removes only its newly
        # processed staging file; it must never unlink the shared committed file.
        original_get_db = server.get_db

        class FailingSharedAssetDatabase:
            def __init__(self, database):
                self.database = database

            def execute(self, sql, parameters=()):
                if "INSERT INTO task_progress_assets" in sql:
                    raise sqlite3.OperationalError("forced shared asset failure")
                return self.database.execute(sql, parameters)

            def __getattr__(self, name):
                return getattr(self.database, name)

        with patch.object(
            server,
            "get_db",
            side_effect=lambda: FailingSharedAssetDatabase(original_get_db()),
        ):
            with self.assertRaises(sqlite3.OperationalError):
                self.client.post(
                    f"/api/tasks/{task_date}/progress/{second_progress['id']}/files",
                    data={"attachment": (io.BytesIO(raw), "failed-copy.txt")},
                    headers={"X-CSRF-Token": self.csrf()},
                )
        self.assertEqual(list(server.UPLOAD_DIR.iterdir()), [shared_path])
        still_available = self.client.get(shared_url)
        self.assertEqual(still_available.status_code, 200)
        still_available.close()

        first_delete = self.client.delete(
            f"/api/tasks/{task_date}/progress/{first_progress['id']}/assets/{first_asset['id']}",
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(first_delete.status_code, 200, first_delete.get_data(as_text=True))
        self.assertTrue(shared_path.is_file())
        remaining_download = self.client.get(shared_url)
        self.assertEqual(remaining_download.status_code, 200)
        remaining_download.close()

        last_delete = self.client.delete(
            f"/api/tasks/{task_date}/progress/{second_progress['id']}/assets/{second_asset['id']}",
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(last_delete.status_code, 200, last_delete.get_data(as_text=True))
        self.assertFalse(shared_path.exists())
        self.assertEqual(list(server.UPLOAD_DIR.iterdir()), [])

        # Equal bytes with different validated types must not be deduplicated
        # into a file carrying the wrong extension or MIME metadata.
        text_upload = self.upload_progress_file(
            first_progress["id"], raw, "evidence.txt", task_date=task_date
        )
        csv_upload = self.upload_progress_file(
            second_progress["id"], raw, "evidence.csv", task_date=task_date
        )
        self.assertEqual(text_upload.status_code, 201, text_upload.get_data(as_text=True))
        self.assertEqual(csv_upload.status_code, 201, csv_upload.get_data(as_text=True))
        self.assertEqual(text_upload.get_json()["asset"]["proofFileMime"], "text/plain")
        self.assertEqual(csv_upload.get_json()["asset"]["proofFileMime"], "text/csv")
        self.assertNotEqual(
            text_upload.get_json()["asset"]["proofFileUrl"],
            csv_upload.get_json()["asset"]["proofFileUrl"],
        )
        self.assertEqual(len(list(server.UPLOAD_DIR.iterdir())), 2)

    def test_startup_cleanup_removes_only_unreferenced_internal_uploads(self):
        self.login_unlocked_owner()
        task_date = "2026-08-01"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        progress = self.create_progress(
            task_date=task_date,
            note="Keep the referenced file",
            progress_percent=10,
        ).get_json()["progress"]
        uploaded = self.upload_progress_file(
            progress["id"], b"referenced", "referenced.txt", task_date=task_date
        ).get_json()["progress"]
        referenced_asset = next(
            asset for asset in uploaded["assets"] if asset["kind"] == "file"
        )
        referenced = server.UPLOAD_DIR / referenced_asset["proofFileUrl"].rsplit("/", 1)[-1]
        orphan = server.UPLOAD_DIR / ("f" * 32 + ".txt")
        interrupted = server.UPLOAD_DIR / ("." + "e" * 32 + ".txt.tmp")
        unrelated = server.UPLOAD_DIR / "operator-note.bin"
        orphan.write_bytes(b"orphan")
        interrupted.write_bytes(b"interrupted")
        unrelated.write_bytes(b"not an application-managed attachment")

        server.init_db()

        self.assertTrue(referenced.is_file())
        self.assertFalse(orphan.exists())
        self.assertFalse(interrupted.exists())
        self.assertTrue(unrelated.is_file())

    def test_stats_legacy_payload_preserves_existing_distraction_log(self):
        self.login_unlocked_owner()
        initial = self.client.put(
            "/api/stats/2026-07-17",
            json={
                "poms": 2,
                "note": "private note",
                "distractions": "phone notification",
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(initial.status_code, 200)

        legacy_update = self.client.put(
            "/api/stats/2026-07-17",
            json={"poms": 3, "note": "updated by an older client"},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(legacy_update.status_code, 200)
        self.assertEqual(
            legacy_update.get_json()["stats"],
            {
                "poms": 3,
                "note": "updated by an older client",
                "distractions": "phone notification",
            },
        )

    def test_attachment_limits_are_consistent_at_10_mib_per_file(self):
        self.assertEqual(server.MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024)
        self.assertEqual(server.app.config["MAX_CONTENT_LENGTH"], 12 * 1024 * 1024)

        app_script = (WORK_DIR / "app" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (WORK_DIR / "app" / "static" / "index.html").read_text(encoding="utf-8")
        nginx_config = (WORK_DIR / "deploy" / "nginx-daily-seal.conf").read_text(encoding="utf-8")
        self.assertIn("const MAX_PROOF_FILE_BYTES = 10 * 1024 * 1024;", app_script)
        self.assertIn("10 MB", app_script)
        self.assertNotIn("30 MB", app_script)
        self.assertGreaterEqual(index_html.count("10 MB"), 2)
        self.assertNotIn("30 MB", index_html)
        self.assertIn("client_max_body_size 12m;", nginx_config)

    def test_blue_day1_is_limited_to_browser_title_and_top_brand(self):
        index_html = (WORK_DIR / "app" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn("<title>Blue Day1</title>", index_html)
        self.assertIn('aria-label="Blue Day1 首页"', index_html)
        self.assertIn("<strong>Blue</strong>", index_html)
        self.assertIn('class="mobile-brand"', index_html)
        self.assertIn("Blue Day1</p>", index_html)
        self.assertIn('<h1 id="visitor-page-title">Blue 的每日记录</h1>', index_html)
        self.assertIn('id="brand-subtitle">Day1</span>', index_html)
        self.assertIn('id="visitor-context-line">沿着今天留下的轨迹，看看事情正走到哪里。</p>', index_html)
        self.assertIn("Blue <span aria-hidden=\"true\">·</span> 看清下一步，安静地继续", index_html)

    def test_progress_and_result_forms_use_unified_remarks_and_multi_file_selection(self):
        index_html = (WORK_DIR / "app" / "static" / "index.html").read_text(encoding="utf-8")
        app_script = (WORK_DIR / "app" / "static" / "app.js").read_text(encoding="utf-8")
        combined = index_html + "\n" + app_script

        self.assertNotIn("未完成原因", combined)
        self.assertNotIn("完成备注", combined)
        self.assertRegex(
            index_html,
            r'<label[^>]+id="result-note-label"[^>]*>\s*备注\s*</label>',
        )
        self.assertIn('id="progress-dialog"', index_html)
        self.assertRegex(
            index_html,
            r'<input[^>]+id="progress-file-input"[^>]+multiple(?:\s|>)',
        )
        self.assertIn('id="progress-links-input"', index_html)
        self.assertIn("每行粘贴一个", index_html)
        self.assertIn("每个文件最大 10 MB", index_html)

    def test_completion_rejects_missing_invalid_unsupported_and_oversize_proof(self):
        self.login_unlocked_owner()
        self.assertEqual(self.put_task(self.client).status_code, 200)

        missing = self.client.post(
            "/api/tasks/2026-07-17/complete",
            data={},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(missing.status_code, 400)

        invalid = self.client.post(
            "/api/tasks/2026-07-17/complete",
            data={"image": (io.BytesIO(b"not an image"), "proof.jpg")},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.get_json()["code"], "invalid_attachment")

        gif_buffer = io.BytesIO()
        server.Image.new("RGB", (2, 2), "red").save(gif_buffer, format="GIF")
        unsupported = self.client.post(
            "/api/tasks/2026-07-17/complete",
            data={"image": (io.BytesIO(gif_buffer.getvalue()), "proof.gif")},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(unsupported.status_code, 400)
        self.assertEqual(unsupported.get_json()["code"], "invalid_attachment")

        oversize = self.client.post(
            "/api/tasks/2026-07-17/complete",
            data={
                "image": (
                    io.BytesIO(b"x" * (server.MAX_ATTACHMENT_BYTES + 1)),
                    "oversize.jpg",
                )
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(oversize.status_code, 413)
        self.assertEqual(oversize.get_json()["code"], "attachment_too_large")
        oversize.close()

        with self.db() as connection:
            task = connection.execute(
                "SELECT done, proof_file FROM tasks WHERE task_date = '2026-07-17'"
            ).fetchone()
        self.assertEqual(task["done"], 0)
        self.assertIsNone(task["proof_file"])
        self.assertEqual(list(server.UPLOAD_DIR.glob("*")), [])

    def test_document_attachments_upload_download_export_and_viewer_access(self):
        self.login_unlocked_owner()
        samples = [
            ("result.pdf", self.pdf_bytes(), "application/pdf", ".pdf"),
            ("notes.txt", "学习完成\n复核通过".encode(), "text/plain", ".txt"),
            ("scores.csv", b"item,score\ngeometry,100\n", "text/csv", ".csv"),
            ("report.docx", self.ooxml_bytes(".docx"), server.ATTACHMENT_MIME_BY_EXTENSION[".docx"], ".docx"),
            ("table.xlsx", self.ooxml_bytes(".xlsx"), server.ATTACHMENT_MIME_BY_EXTENSION[".xlsx"], ".xlsx"),
            ("slides.pptx", self.ooxml_bytes(".pptx"), server.ATTACHMENT_MIME_BY_EXTENSION[".pptx"], ".pptx"),
        ]
        records = []
        for offset, (name, raw, mime, suffix) in enumerate(samples, start=1):
            task_date = f"2026-03-{offset:02d}"
            self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
            completed = self.client.post(
                f"/api/tasks/{task_date}/complete",
                data={"attachment": (io.BytesIO(raw), name)},
                headers={"X-CSRF-Token": self.csrf()},
            )
            self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
            task = completed.get_json()["task"]
            self.assertIsNone(task["proofImageUrl"])
            self.assertEqual(task["proofFileName"], name)
            self.assertEqual(task["proofFileMime"], mime)
            self.assertEqual(task["proofFileSize"], len(raw))
            self.assertRegex(task["proofFileUrl"], rf"^/api/proofs/[a-f0-9]{{32}}\{suffix}$")
            downloaded = self.client.get(task["proofFileUrl"])
            self.assertEqual(downloaded.status_code, 200)
            self.assertEqual(downloaded.mimetype, mime)
            self.assertEqual(downloaded.data, raw)
            self.assertTrue(downloaded.headers["Content-Disposition"].startswith("attachment;"))
            self.assertIn(name, downloaded.headers["Content-Disposition"])
            self.assertEqual(int(downloaded.headers["Content-Length"]), len(raw))
            downloaded.close()
            records.append(task)

        ranged = self.client.get(records[0]["proofFileUrl"], headers={"Range": "bytes=0-3"})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.data, samples[0][1][:4])
        self.assertEqual(ranged.headers["Content-Range"], f"bytes 0-3/{len(samples[0][1])}")
        ranged.close()

        exported = json.loads(self.client.get("/api/export").get_data(as_text=True))
        self.assertEqual(exported["tasks"]["2026-03-01"]["proofFileName"], "result.pdf")
        self.assertEqual(exported["tasks"]["2026-03-01"]["proofFileMime"], "application/pdf")

        viewer = server.app.test_client()
        self.assertEqual(self.register_viewer(viewer).status_code, 200)
        for record in records:
            viewer_download = viewer.get(record["proofFileUrl"])
            self.assertEqual(viewer_download.status_code, 200)
            viewer_download.close()

        with patch.object(server, "business_today_key", return_value="2026-03-07"):
            stage_id = self.create_stage(
                title="Document proof stage",
                description="Confirm the shared attachment path",
            ).get_json()["stage"]["id"]
            stage_pdf = self.pdf_bytes()
            stage_completed = self.client.post(
                f"/api/stages/{stage_id}/complete",
                data={"attachment": (io.BytesIO(stage_pdf), "stage-result.pdf")},
                headers={"X-CSRF-Token": self.csrf()},
            )
        self.assertEqual(stage_completed.status_code, 200, stage_completed.get_data(as_text=True))
        stage = stage_completed.get_json()["stage"]
        self.assertEqual(stage["proofFileName"], "stage-result.pdf")
        self.assertEqual(stage["proofFileMime"], "application/pdf")
        stage_download = viewer.get(stage["proofFileUrl"])
        self.assertEqual(stage_download.status_code, 200)
        self.assertEqual(stage_download.data, stage_pdf)
        self.assertTrue(stage_download.headers["Content-Disposition"].startswith("attachment;"))
        stage_download.close()
        anonymous = server.app.test_client()
        self.assertEqual(anonymous.get(records[0]["proofFileUrl"]).status_code, 401)

    def test_attachment_content_validation_and_exact_business_size_limit(self):
        self.login_unlocked_owner()
        self.assertEqual(self.put_task(self.client, task_date="2026-02-01").status_code, 200)
        invalid_samples = [
            ("page.html", b"<!doctype html><html></html>"),
            ("renamed.txt", b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
            ("script.txt", b"const secret = window.location.href;"),
            ("fake.pdf", b"<!doctype html><html></html>"),
            ("program.pdf", b"MZ" + b"\x00" * 128),
            ("wrong.docx", self.ooxml_bytes(".pptx")),
            ("macro.docx", self.ooxml_bytes(".docx", {"word/vbaProject.bin": b"macro"})),
            ("mismatch.jpg", self.png_bytes()),
        ]
        for name, raw in invalid_samples:
            response = self.client.post(
                "/api/tasks/2026-02-01/complete",
                data={"attachment": (io.BytesIO(raw), name)},
                headers={"X-CSRF-Token": self.csrf()},
            )
            self.assertEqual(response.status_code, 400, name)
            self.assertEqual(response.get_json()["code"], "invalid_attachment")
        multiple = self.client.post(
            "/api/tasks/2026-02-01/complete",
            data={
                "attachment": (io.BytesIO(b"safe text"), "one.txt"),
                "image": (io.BytesIO(b"safe text"), "two.txt"),
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(multiple.status_code, 400)
        self.assertEqual(multiple.get_json()["code"], "multiple_attachments")
        self.assertEqual(list(server.UPLOAD_DIR.glob("*")), [])

        exact = b"a" * server.MAX_ATTACHMENT_BYTES
        accepted = self.client.post(
            "/api/tasks/2026-02-01/complete",
            data={"attachment": (io.BytesIO(exact), "exact.txt")},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(accepted.status_code, 200, accepted.get_data(as_text=True))
        self.assertEqual(accepted.get_json()["task"]["proofFileSize"], server.MAX_ATTACHMENT_BYTES)

        self.assertEqual(self.put_task(self.client, task_date="2026-02-02").status_code, 200)
        rejected = self.client.post(
            "/api/tasks/2026-02-02/complete",
            data={"attachment": (io.BytesIO(exact + b"b"), "too-large.txt")},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(rejected.status_code, 413)
        self.assertEqual(rejected.get_json()["code"], "attachment_too_large")
        self.assertEqual(len(list(server.UPLOAD_DIR.glob("*"))), 1)

    def test_mobile_48mp_jpeg_is_safely_resized_and_accepted(self):
        self.login_unlocked_owner()
        self.assertEqual(self.put_task(self.client, task_date="2026-02-03").status_code, 200)
        raw = self.mobile_48mp_jpeg_bytes()
        self.assertLess(len(raw), server.MAX_ATTACHMENT_BYTES)
        completed = self.client.post(
            "/api/tasks/2026-02-03/complete",
            data={"attachment": (io.BytesIO(raw), "ipad-photo.jpg")},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
        task = completed.get_json()["task"]
        self.assertEqual(task["proofFileMime"], "image/jpeg")
        proof = self.client.get(task["proofFileUrl"])
        self.assertEqual(proof.status_code, 200)
        with server.Image.open(io.BytesIO(proof.data)) as decoded:
            self.assertLessEqual(decoded.width, 2400)
            self.assertLessEqual(decoded.height, 2400)
        proof.close()

    def test_highly_compressed_oversized_png_is_rejected_before_pixel_decode(self):
        self.login_unlocked_owner()
        task_date = "2026-02-13"
        self.assertEqual(self.put_task(self.client, task_date=task_date).status_code, 200)
        image = server.Image.new("1", (5000, 4200), 1)
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=True)
        image.close()
        raw = output.getvalue()
        self.assertLess(len(raw), server.MAX_ATTACHMENT_BYTES)
        self.assertGreater(5000 * 4200, server.MAX_NON_JPEG_IMAGE_PIXELS)

        with patch.object(
            server.ImageOps,
            "exif_transpose",
            wraps=server.ImageOps.exif_transpose,
        ) as transpose:
            rejected = self.client.post(
                f"/api/tasks/{task_date}/complete",
                data={"attachment": (io.BytesIO(raw), "compressed.png")},
                headers={"X-CSRF-Token": self.csrf()},
            )
        self.assertEqual(rejected.status_code, 400, rejected.get_data(as_text=True))
        self.assertEqual(rejected.get_json()["code"], "invalid_attachment")
        transpose.assert_not_called()
        self.assertEqual(list(server.UPLOAD_DIR.iterdir()), [])

    def test_attachment_filenames_are_safely_preserved_and_truncated(self):
        self.login_unlocked_owner()
        self.assertEqual(self.put_task(self.client, task_date="2026-02-04").status_code, 200)
        unsafe_name = "..\\..\\private/中文 证明🚀\u202e.txt"
        completed = self.client.post(
            "/api/tasks/2026-02-04/complete",
            data={"attachment": (io.BytesIO("核对完成".encode()), unsafe_name)},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
        task = completed.get_json()["task"]
        self.assertEqual(task["proofFileName"], "中文 证明🚀.txt")
        downloaded = self.client.get(task["proofFileUrl"])
        disposition = downloaded.headers["Content-Disposition"]
        self.assertIn("filename*=UTF-8''", disposition)
        self.assertNotIn("..", disposition)
        self.assertNotIn("\r", disposition)
        self.assertNotIn("\n", disposition)
        downloaded.close()

        self.assertEqual(self.put_task(self.client, task_date="2026-02-05").status_code, 200)
        long_name = "folder/" + ("很长的文件名" * 40) + "🚀.txt"
        long_completed = self.client.post(
            "/api/tasks/2026-02-05/complete",
            data={"attachment": (io.BytesIO(b"long name proof"), long_name)},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(long_completed.status_code, 200)
        stored_name = long_completed.get_json()["task"]["proofFileName"]
        self.assertLessEqual(len(stored_name.encode("utf-8")), server.MAX_ORIGINAL_FILENAME_BYTES)
        self.assertTrue(stored_name.endswith(".txt"))
        self.assertNotIn("/", stored_name)
        self.assertNotIn("\\", stored_name)

    def test_attachment_replacement_and_database_failure_remove_orphan_files(self):
        self.login_unlocked_owner()
        self.assertEqual(self.put_task(self.client, task_date="2026-01-20").status_code, 200)
        first = self.client.post(
            "/api/tasks/2026-01-20/complete",
            data={"attachment": (io.BytesIO(b"first proof"), "first.txt")},
            headers={"X-CSRF-Token": self.csrf()},
        ).get_json()["task"]
        old_path = server.UPLOAD_DIR / first["proofFileUrl"].rsplit("/", 1)[-1]
        self.assertTrue(old_path.is_file())
        replacement = self.client.post(
            "/api/tasks/2026-01-20/complete",
            data={"attachment": (io.BytesIO(self.pdf_bytes()), "replacement.pdf")},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(replacement.status_code, 200)
        self.assertFalse(old_path.exists())
        current_files = set(server.UPLOAD_DIR.iterdir())
        self.assertEqual(len(current_files), 1)

        original_get_db = server.get_db
        task_failure_token = self.csrf()

        class FailingTaskDatabase:
            def __init__(self, database):
                self.database = database

            def execute(self, sql, parameters=()):
                if sql.startswith("UPDATE tasks SET done"):
                    raise sqlite3.OperationalError("forced write failure")
                return self.database.execute(sql, parameters)

            def rollback(self):
                self.database.rollback()

            def __getattr__(self, name):
                return getattr(self.database, name)

        with patch.object(
            server,
            "get_db",
            side_effect=lambda: FailingTaskDatabase(original_get_db()),
        ):
            with self.assertRaises(sqlite3.OperationalError):
                self.client.post(
                    "/api/tasks/2026-01-20/complete",
                    data={"attachment": (io.BytesIO(b"orphan candidate"), "failed.txt")},
                    headers={"X-CSRF-Token": task_failure_token},
                )
        self.assertEqual(set(server.UPLOAD_DIR.iterdir()), current_files)

        class LostTaskRaceDatabase:
            def __init__(self, database):
                self.database = database

            def execute(self, sql, parameters=()):
                if sql.startswith("UPDATE tasks SET done"):
                    return type("Cursor", (), {"rowcount": 0})()
                return self.database.execute(sql, parameters)

            def rollback(self):
                self.database.rollback()

            def __getattr__(self, name):
                return getattr(self.database, name)

        task_race_token = self.csrf()
        with patch.object(
            server,
            "get_db",
            side_effect=lambda: LostTaskRaceDatabase(original_get_db()),
        ):
            lost_task_race = self.client.post(
                "/api/tasks/2026-01-20/complete",
                data={"attachment": (io.BytesIO(b"concurrent candidate"), "race.txt")},
                headers={"X-CSRF-Token": task_race_token},
            )
        self.assertEqual(lost_task_race.status_code, 409)
        self.assertEqual(lost_task_race.get_json()["code"], "proof_conflict")
        self.assertEqual(set(server.UPLOAD_DIR.iterdir()), current_files)

        with patch.object(server, "business_today_key", return_value="2026-01-21"):
            stage_id = self.create_stage(title="Concurrent stage").get_json()["stage"]["id"]
        stage_race_token = self.csrf()

        class LostStageRaceDatabase:
            def __init__(self, database):
                self.database = database

            def execute(self, sql, parameters=()):
                if sql.startswith("UPDATE stages SET status = 'completed'"):
                    return type("Cursor", (), {"rowcount": 0})()
                return self.database.execute(sql, parameters)

            def rollback(self):
                self.database.rollback()

            def __getattr__(self, name):
                return getattr(self.database, name)

        with patch.object(
            server,
            "get_db",
            side_effect=lambda: LostStageRaceDatabase(original_get_db()),
        ):
            lost_race = self.client.post(
                f"/api/stages/{stage_id}/complete",
                data={"attachment": (io.BytesIO(b"stage orphan"), "stage.txt")},
                headers={"X-CSRF-Token": stage_race_token},
            )
        self.assertEqual(lost_race.status_code, 409)
        self.assertEqual(set(server.UPLOAD_DIR.iterdir()), current_files)

    def test_task_completion_accepts_http_evidence_url_and_exports_it(self):
        self.login_unlocked_owner()
        self.assertEqual(self.put_task(self.client, task_date="2026-06-01").status_code, 200)

        for invalid_url in (
            "ftp://example.test/proof",
            "https://user:password@example.test/proof",
            "https://example.test/contains a space",
        ):
            invalid = self.client.post(
                "/api/tasks/2026-06-01/complete",
                data={"proofUrl": invalid_url},
                headers={"X-CSRF-Token": self.csrf()},
            )
            self.assertEqual(invalid.status_code, 400)
        with self.db() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT done FROM tasks WHERE task_date = '2026-06-01'"
                ).fetchone()["done"],
                0,
            )

        evidence_url = "http://evidence.example.test/daily-result?id=7"
        completed = self.client.post(
            "/api/tasks/2026-06-01/complete",
            data={"proofUrl": evidence_url},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
        task = completed.get_json()["task"]
        self.assertTrue(task["done"])
        self.assertEqual(task["proofUrl"], evidence_url)
        self.assertIsNone(task["proofImageUrl"])

        owner_data = self.client.get("/api/data").get_json()
        stored = next(item for item in owner_data["tasks"] if item["date"] == "2026-06-01")
        self.assertEqual(stored["proofUrl"], evidence_url)
        exported = json.loads(self.client.get("/api/export").get_data(as_text=True))
        self.assertEqual(exported["tasks"]["2026-06-01"]["proofUrl"], evidence_url)

        self.assertEqual(self.put_task(self.client, task_date="2026-06-02").status_code, 200)
        secure_url = "https://evidence.example.test/secure-daily-result"
        secure_completed = self.client.post(
            "/api/tasks/2026-06-02/complete",
            data={"proofUrl": secure_url},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(secure_completed.status_code, 200)
        self.assertEqual(secure_completed.get_json()["task"]["proofUrl"], secure_url)

        viewer_client = server.app.test_client()
        self.assertEqual(self.register_viewer(viewer_client).status_code, 200)
        viewer_tasks = viewer_client.get("/api/data").get_json()["tasks"]
        viewer_record = next(item for item in viewer_tasks if item["date"] == "2026-06-01")
        self.assertEqual(viewer_record["proofUrl"], evidence_url)

    def test_init_db_migrates_legacy_tasks_and_stats_without_losing_rows(self):
        legacy_created_at = 1_700_000_000
        legacy_task_file = f"{'a' * 32}.jpg"
        legacy_stage_file = f"{'b' * 32}.jpg"
        image_output = io.BytesIO()
        server.Image.new("RGB", (3, 2), "green").save(image_output, format="JPEG")
        legacy_image = image_output.getvalue()
        (server.UPLOAD_DIR / legacy_task_file).write_bytes(legacy_image)
        (server.UPLOAD_DIR / legacy_stage_file).write_bytes(legacy_image)
        with self.db() as connection:
            connection.executescript(
                """
                DROP TABLE task_progress_assets;
                DROP TABLE task_progress;
                DROP TABLE tasks;
                CREATE TABLE tasks (
                    task_date TEXT PRIMARY KEY,
                    text TEXT NOT NULL,
                    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
                    created_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    proof_text TEXT,
                    proof_file TEXT,
                    proof_mime TEXT
                );
                CREATE TABLE task_progress (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_date TEXT NOT NULL REFERENCES tasks(task_date) ON DELETE CASCADE,
                    note TEXT NOT NULL DEFAULT '',
                    progress_percent INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE task_progress_assets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    progress_id INTEGER NOT NULL REFERENCES task_progress(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL DEFAULT 0,
                    kind TEXT NOT NULL,
                    proof_url TEXT,
                    proof_file TEXT,
                    proof_mime TEXT,
                    proof_original_name TEXT,
                    proof_size INTEGER,
                    created_at INTEGER NOT NULL
                );
                DROP TABLE stages;
                CREATE TABLE stages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    started_at INTEGER NOT NULL,
                    started_date TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    completed_date TEXT,
                    duration_days INTEGER,
                    proof_text TEXT,
                    proof_url TEXT,
                    proof_file TEXT,
                    proof_mime TEXT
                );
                DROP TABLE daily_stats;
                CREATE TABLE daily_stats (
                    stat_date TEXT PRIMARY KEY,
                    poms INTEGER NOT NULL DEFAULT 0 CHECK (poms >= 0),
                    note TEXT NOT NULL DEFAULT '',
                    updated_at INTEGER NOT NULL
                );
                """
            )
            connection.execute(
                "INSERT INTO tasks(task_date, text, done, created_at, proof_text, proof_file, proof_mime) "
                "VALUES ('2026-01-15', 'legacy task', 1, ?, 'legacy note', ?, 'image/jpeg')",
                (legacy_created_at, legacy_task_file),
            )
            connection.execute(
                "INSERT INTO stages(title, status, started_at, started_date, updated_at, completed_at, "
                "completed_date, duration_days, proof_file, proof_mime) "
                "VALUES ('legacy stage', 'completed', ?, '2026-01-01', ?, ?, '2026-01-02', 2, ?, 'image/jpeg')",
                (legacy_created_at, legacy_created_at, legacy_created_at, legacy_stage_file),
            )
            progress_id = connection.execute(
                "INSERT INTO task_progress(task_date, note, progress_percent, created_at) "
                "VALUES ('2026-01-15', 'legacy checkpoint', 35, ?)",
                (legacy_created_at,),
            ).lastrowid
            connection.execute(
                "INSERT INTO task_progress_assets(progress_id, position, kind, proof_url, created_at) "
                "VALUES (?, 0, 'link', 'https://example.test/legacy-progress', ?)",
                (progress_id, legacy_created_at),
            )
            connection.execute(
                "INSERT INTO daily_stats(stat_date, poms, note, updated_at) "
                "VALUES ('2026-01-15', 5, 'legacy private note', ?)",
                (legacy_created_at,),
            )

        server.init_db()
        with self.db() as connection:
            columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(tasks)").fetchall()
            }
            row = connection.execute(
                "SELECT task_date, text, created_at, proof_text, proof_url, "
                "proof_original_name, proof_size, result_version, "
                "result_confirmed_progress_id FROM tasks"
            ).fetchone()
            stage_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(stages)").fetchall()
            }
            stage_row = connection.execute(
                "SELECT proof_original_name, proof_size FROM stages"
            ).fetchone()
            stat_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(daily_stats)").fetchall()
            }
            stat_row = connection.execute(
                "SELECT stat_date, poms, note, distractions FROM daily_stats"
            ).fetchone()
            progress_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(task_progress)").fetchall()
            }
            asset_columns = {
                row["name"]
                for row in connection.execute(
                    "PRAGMA table_info(task_progress_assets)"
                ).fetchall()
            }
            progress_row = connection.execute(
                "SELECT task_date, note, progress_percent, client_key FROM task_progress"
            ).fetchone()
            progress_asset_row = connection.execute(
                "SELECT kind, proof_url, client_key, source_sha256, source_size "
                "FROM task_progress_assets"
            ).fetchone()
            index_names = {
                row["name"]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'index'"
                ).fetchall()
            }
        self.assertIn("proof_url", columns)
        self.assertIn("proof_original_name", columns)
        self.assertIn("proof_size", columns)
        self.assertIn("result_version", columns)
        self.assertIn("result_confirmed_progress_id", columns)
        self.assertIn("proof_original_name", stage_columns)
        self.assertIn("proof_size", stage_columns)
        self.assertIn("distractions", stat_columns)
        self.assertEqual(row["task_date"], "2026-01-15")
        self.assertEqual(row["text"], "legacy task")
        self.assertEqual(row["created_at"], legacy_created_at)
        self.assertEqual(row["proof_text"], "legacy note")
        self.assertIsNone(row["proof_url"])
        self.assertEqual(row["proof_original_name"], "证明图片.jpg")
        self.assertEqual(row["proof_size"], len(legacy_image))
        self.assertEqual(row["result_version"], 0)
        self.assertIsNone(row["result_confirmed_progress_id"])
        self.assertEqual(stage_row["proof_original_name"], "证明图片.jpg")
        self.assertEqual(stage_row["proof_size"], len(legacy_image))
        self.assertEqual(stat_row["stat_date"], "2026-01-15")
        self.assertEqual(stat_row["poms"], 5)
        self.assertEqual(stat_row["note"], "legacy private note")
        self.assertEqual(stat_row["distractions"], "")
        self.assertIn("client_key", progress_columns)
        self.assertTrue(
            {"client_key", "source_sha256", "source_size"}.issubset(asset_columns)
        )
        self.assertEqual(progress_row["task_date"], "2026-01-15")
        self.assertEqual(progress_row["note"], "legacy checkpoint")
        self.assertEqual(progress_row["progress_percent"], 35)
        self.assertIsNone(progress_row["client_key"])
        self.assertEqual(progress_asset_row["kind"], "link")
        self.assertEqual(
            progress_asset_row["proof_url"], "https://example.test/legacy-progress"
        )
        self.assertIsNone(progress_asset_row["client_key"])
        self.assertIsNone(progress_asset_row["source_sha256"])
        self.assertIsNone(progress_asset_row["source_size"])
        self.assertIn("idx_task_progress_client_key", index_names)
        self.assertIn("idx_task_progress_assets_client_key", index_names)
        self.assertIn("idx_task_progress_assets_source", index_names)

        self.login_unlocked_owner()
        task = self.client.get("/api/data").get_json()["tasks"][0]
        self.assertEqual(task["text"], "legacy task")
        self.assertEqual(task["proofUrl"], "")
        self.assertEqual(task["proofFileName"], "证明图片.jpg")
        self.assertEqual(task["proofFileSize"], len(legacy_image))
        self.assertEqual(task["proofImageUrl"], task["proofFileUrl"])
        self.assertEqual(task["progressEntries"][0]["note"], "legacy checkpoint")
        stats = self.client.get("/api/data").get_json()["stats"]["2026-01-15"]
        self.assertEqual(
            stats,
            {"poms": 5, "note": "legacy private note", "distractions": ""},
        )

    def test_viewer_sees_public_completion_and_poms_but_not_private_text(self):
        owner_client = server.app.test_client()
        self.login_unlocked_owner(owner_client)
        today = server.business_today_key()
        future_date = (
            server.date.fromisoformat(today) + server.timedelta(days=1)
        ).isoformat()
        zero_date = (
            server.date.fromisoformat(today) - server.timedelta(days=1)
        ).isoformat()
        self.assertEqual(
            self.put_task(owner_client, task_date=today).status_code, 200
        )
        self.assertEqual(
            owner_client.put(
                f"/api/stats/{today}",
                json={
                    "poms": 7,
                    "note": "private owner note",
                    "distractions": "private distraction log",
                },
                headers={"X-CSRF-Token": self.csrf(owner_client)},
            ).status_code,
            200,
        )
        self.assertEqual(
            owner_client.put(
                f"/api/stats/{future_date}",
                json={
                    "poms": 11,
                    "note": "private future note",
                    "distractions": "private future distraction",
                },
                headers={"X-CSRF-Token": self.csrf(owner_client)},
            ).status_code,
            200,
        )
        self.assertEqual(
            owner_client.put(
                f"/api/stats/{zero_date}",
                json={
                    "poms": 0,
                    "note": "private zero-day note",
                    "distractions": "private zero-day distraction",
                },
                headers={"X-CSRF-Token": self.csrf(owner_client)},
            ).status_code,
            200,
        )
        completed = owner_client.post(
            f"/api/tasks/{today}/complete",
            data={
                "proofText": "Visible completion result",
                "image": (io.BytesIO(self.png_bytes()), "result.png"),
            },
            headers={"X-CSRF-Token": self.csrf(owner_client)},
        ).get_json()["task"]
        owner_payload = owner_client.get("/api/data").get_json()
        self.assertEqual(owner_payload["publicPoms"], {today: 7})
        self.assertIn(future_date, owner_payload["stats"])

        viewer_client = server.app.test_client()
        self.assertEqual(self.register_viewer(viewer_client).status_code, 200)
        viewer_data = viewer_client.get("/api/data")
        self.assertEqual(viewer_data.status_code, 200)
        payload = viewer_data.get_json()
        self.assertNotIn("stats", payload)
        self.assertEqual(payload["publicPoms"], {today: 7})
        raw_viewer_data = viewer_data.get_data(as_text=True)
        # Progress-entry `note` is intentionally public; the private daily
        # note remains absent because viewers never receive the `stats` map.
        self.assertNotIn('"distractions"', raw_viewer_data)
        self.assertNotIn("private owner note", raw_viewer_data)
        self.assertNotIn("private distraction log", raw_viewer_data)
        self.assertNotIn("private future note", raw_viewer_data)
        self.assertNotIn("private future distraction", raw_viewer_data)
        self.assertNotIn("private zero-day note", raw_viewer_data)
        self.assertNotIn("private zero-day distraction", raw_viewer_data)
        self.assertEqual(payload["tasks"][0]["proofText"], "Visible completion result")
        self.assertEqual(payload["user"]["role"], "viewer")
        self.assertNotIn("passwordHash", payload["user"])
        self.assertNotIn("password_hash", viewer_data.get_data(as_text=True))
        self.assertNotIn("scrypt$", viewer_data.get_data(as_text=True))
        self.assertNotIn(self.OWNER_EMAIL, viewer_data.get_data(as_text=True))

        proof = viewer_client.get(completed["proofImageUrl"])
        self.assertEqual(proof.status_code, 200)
        self.assertEqual(proof.content_type, "image/jpeg")
        proof.close()
        anonymous_client = server.app.test_client()
        self.assertEqual(anonymous_client.get(completed["proofImageUrl"]).status_code, 401)

    def test_viewer_cannot_see_future_tasks_or_future_proofs(self):
        owner_client = server.app.test_client()
        self.login_unlocked_owner(owner_client)
        future_date = server.validate_date_key(
            (server.date.fromisoformat(server.business_today_key()) + server.timedelta(days=1)).isoformat()
        )
        self.assertEqual(
            self.put_task(owner_client, task_date=future_date, text="private future plan").status_code,
            200,
        )
        completed = owner_client.post(
            f"/api/tasks/{future_date}/complete",
            data={
                "proofText": "future proof",
                "image": (io.BytesIO(self.png_bytes()), "future.png"),
            },
            headers={"X-CSRF-Token": self.csrf(owner_client)},
        )
        self.assertEqual(completed.status_code, 200)
        proof_url = completed.get_json()["task"]["proofImageUrl"]

        viewer_client = server.app.test_client()
        self.assertEqual(self.register_viewer(viewer_client).status_code, 200)
        viewer_payload = viewer_client.get("/api/data").get_json()
        self.assertNotIn(future_date, {item["date"] for item in viewer_payload["tasks"]})
        hidden_proof = viewer_client.get(proof_url)
        self.assertEqual(hidden_proof.status_code, 404)
        self.assertEqual(hidden_proof.get_json()["code"], "not_found")

    def test_import_merges_without_overwriting_existing_records(self):
        self.login_unlocked_owner()
        self.assertEqual(self.put_task(self.client, text="keep this task").status_code, 200)
        self.assertEqual(
            self.client.put(
                "/api/stats/2026-07-17",
                json={
                    "poms": 3,
                    "note": "keep this note",
                    "distractions": "keep this distraction",
                },
                headers={"X-CSRF-Token": self.csrf()},
            ).status_code,
            200,
        )
        imported = self.client.post(
            "/api/import",
            json={
                "data": {
                    "tasks": {
                        "2026-07-17": {
                            "text": "must not overwrite",
                            "done": True,
                            "progressEntries": [
                                {
                                    "note": "must not mix into the existing task",
                                    "progressPercent": 75,
                                    "createdAt": "2026-07-17T08:00:00+00:00",
                                    "assets": [],
                                }
                            ],
                        },
                        "2026-07-18": {"text": "new imported task", "done": True},
                    },
                    "poms": {"2026-07-17": 99, "2026-07-18": 2},
                    "notes": {
                        "2026-07-17": "must not overwrite",
                        "2026-07-18": "new imported note",
                    },
                    "distractions": {
                        "2026-07-17": "must not overwrite",
                        "2026-07-18": "new imported distraction",
                    },
                }
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(imported.status_code, 200, imported.get_data(as_text=True))
        self.assertEqual(imported.get_json()["importedTasks"], 1)
        self.assertEqual(imported.get_json()["importedProgressEntries"], 0)
        self.assertEqual(imported.get_json()["skippedMismatchedProgressEntries"], 1)
        payload = self.client.get("/api/data").get_json()
        tasks = {item["date"]: item for item in payload["tasks"]}
        self.assertEqual(tasks["2026-07-17"]["text"], "keep this task")
        self.assertFalse(tasks["2026-07-17"]["done"])
        self.assertEqual(tasks["2026-07-18"]["text"], "new imported task")
        self.assertTrue(tasks["2026-07-18"]["done"])
        self.assertEqual(tasks["2026-07-17"]["progressEntries"], [])
        self.assertEqual(
            payload["stats"]["2026-07-17"],
            {
                "poms": 3,
                "note": "keep this note",
                "distractions": "keep this distraction",
            },
        )
        self.assertEqual(
            payload["stats"]["2026-07-18"],
            {
                "poms": 2,
                "note": "new imported note",
                "distractions": "new imported distraction",
            },
        )

    def test_original_export_notes_import_as_distraction_logs(self):
        self.login_unlocked_owner()
        imported = self.client.post(
            "/api/import",
            json={
                "data": {
                    "tasks": {},
                    "poms": {"2026-01-20": 2},
                    "notes": {"2026-01-20": "looked at the phone"},
                }
            },
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(imported.status_code, 200, imported.get_data(as_text=True))

        owner_data = self.client.get("/api/data").get_json()
        self.assertEqual(
            owner_data["stats"]["2026-01-20"],
            {
                "poms": 2,
                "note": "",
                "distractions": "looked at the phone",
            },
        )
        exported = json.loads(self.client.get("/api/export").get_data(as_text=True))
        self.assertEqual(exported["notes"]["2026-01-20"], "")
        self.assertEqual(
            exported["distractions"]["2026-01-20"], "looked at the phone"
        )

    def test_logout_revokes_session_and_user_agent_change_invalidates_it(self):
        self.login_unlocked_owner()
        self.assertEqual(self.client.get("/api/data").status_code, 200)

        no_csrf = self.client.post("/api/logout")
        self.assertEqual(no_csrf.status_code, 403)
        self.assertEqual(self.client.get("/api/data").status_code, 200)

        logout = self.client.post(
            "/api/logout",
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(logout.status_code, 200)
        self.assertTrue(any("ds_session=;" in line for line in logout.headers.getlist("Set-Cookie")))
        self.assertEqual(self.client.get("/api/data").status_code, 401)
        with self.db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)

        second_client = server.app.test_client()
        self.assertEqual(self.login_owner(second_client).status_code, 200)
        changed_agent = second_client.get(
            "/api/data",
            headers={"User-Agent": "a-different-browser"},
        )
        self.assertEqual(changed_agent.status_code, 401)
        self.assertEqual(changed_agent.get_json()["code"], "authentication_required")
        with self.db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)

    def test_login_failures_are_rate_limited_and_do_not_reveal_user_existence(self):
        unknown_client = server.app.test_client()
        known_client = server.app.test_client()
        unknown = unknown_client.post(
            "/api/login",
            json={"email": "unknown@example.test", "password": "WrongPass!123"},
            headers={"X-CSRF-Token": self.csrf(unknown_client)},
        )
        known = known_client.post(
            "/api/login",
            json={"email": self.OWNER_EMAIL, "password": "WrongPass!123"},
            headers={"X-CSRF-Token": self.csrf(known_client)},
        )
        self.assertEqual(unknown.status_code, 401)
        self.assertEqual(known.status_code, 401)
        self.assertEqual(unknown.get_json()["code"], "invalid_credentials")
        self.assertEqual(known.get_json()["code"], "invalid_credentials")
        self.assertEqual(unknown.get_json()["error"], known.get_json()["error"])

        rate_client = server.app.test_client()
        token = self.csrf(rate_client)
        # One known-account failure is already recorded above. Four additional
        # failures reach the five-failure threshold; the following attempt is
        # rejected before a password check.
        for _ in range(4):
            response = rate_client.post(
                "/api/login",
                json={"email": self.OWNER_EMAIL, "password": "WrongPass!123"},
                headers={"X-CSRF-Token": token},
            )
            self.assertEqual(response.status_code, 401)
        limited = rate_client.post(
            "/api/login",
            json={"email": self.OWNER_EMAIL, "password": self.OWNER_TEMP_PASSWORD},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.get_json()["code"], "rate_limited")

    def test_security_headers_are_applied_to_success_and_error_responses(self):
        responses = [
            self.client.get("/api/session"),
            self.client.get("/api/data"),
            self.client.get("/api/not-found"),
        ]
        for response in responses:
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(response.headers["X-Frame-Options"], "DENY")
            self.assertEqual(
                response.headers["Referrer-Policy"],
                "strict-origin-when-cross-origin",
            )
            self.assertEqual(
                response.headers["Permissions-Policy"],
                "camera=(), microphone=(), geolocation=()",
            )
            csp = response.headers["Content-Security-Policy"]
            self.assertIn("default-src 'self'", csp)
            self.assertIn("object-src 'none'", csp)
            self.assertIn("frame-ancestors 'none'", csp)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertNotIn("Strict-Transport-Security", response.headers)

    def test_stage_lifecycle_is_persistent_single_active_and_completion_is_idempotent(self):
        self.login_unlocked_owner()
        with patch.object(server, "business_today_key", return_value="2026-07-16"):
            created = self.create_stage(
                title="Geometry foundation",
                description="Complete the first geometry phase",
            )
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        stage = created.get_json()["stage"]
        stage_id = stage["id"]
        self.assertEqual(stage["status"], "active")
        self.assertEqual(stage["startDate"], "2026-07-16")
        self.assertIsNone(stage["completedAt"])
        self.assertIsNone(stage["durationDays"])

        # Running the additive schema initialization again must retain existing
        # stage and legacy data.
        server.init_db()
        persisted = self.client.get(f"/api/stages/{stage_id}")
        self.assertEqual(persisted.status_code, 200)
        self.assertEqual(persisted.get_json()["stage"]["title"], "Geometry foundation")

        blocked = self.create_stage(title="Must wait", description="Second phase")
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.get_json()["code"], "active_stage_exists")

        no_csrf = self.client.put(
            f"/api/stages/{stage_id}",
            json={"description": "must not be saved"},
        )
        self.assertEqual(no_csrf.status_code, 403)
        self.assertEqual(no_csrf.get_json()["code"], "csrf_failed")
        invalid = self.client.put(
            f"/api/stages/{stage_id}",
            json={"title": " ", "description": "invalid"},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(invalid.status_code, 400)
        too_long = self.client.put(
            f"/api/stages/{stage_id}",
            json={"description": "x" * (server.MAX_STAGE_DESCRIPTION_LENGTH + 1)},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(too_long.status_code, 400)

        edited = self.client.put(
            f"/api/stages/{stage_id}",
            json={"description": "Revised phase target"},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(edited.status_code, 200)
        self.assertEqual(edited.get_json()["stage"]["title"], "Geometry foundation")
        self.assertEqual(edited.get_json()["stage"]["description"], "Revised phase target")

        with patch.object(server, "business_today_key", return_value="2026-07-18"):
            completed = self.client.post(
                f"/api/stages/{stage_id}/complete",
                json={"proofText": "All phase goals verified"},
                headers={"X-CSRF-Token": self.csrf()},
            )
        self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
        completed_stage = completed.get_json()["stage"]
        self.assertFalse(completed.get_json()["idempotent"])
        self.assertEqual(completed_stage["status"], "completed")
        self.assertEqual(completed_stage["completionDate"], "2026-07-18")
        self.assertEqual(completed_stage["durationDays"], 3)
        self.assertEqual(completed_stage["proofText"], "All phase goals verified")
        first_completed_at = completed_stage["completedAt"]

        with self.db() as connection:
            stored = connection.execute(
                "SELECT status, started_date, completed_at, completed_date, duration_days, proof_text "
                "FROM stages WHERE id = ?",
                (stage_id,),
            ).fetchone()
        stored_values = dict(stored)
        self.assertIsInstance(stored_values.pop("completed_at"), int)
        self.assertEqual(stored_values, {
            "status": "completed",
            "started_date": "2026-07-16",
            "completed_date": "2026-07-18",
            "duration_days": 3,
            "proof_text": "All phase goals verified",
        })

        repeat = self.client.post(
            f"/api/stages/{stage_id}/complete",
            json={"proofText": "All phase goals verified"},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(repeat.status_code, 200)
        self.assertTrue(repeat.get_json()["idempotent"])
        self.assertEqual(repeat.get_json()["stage"]["completedAt"], first_completed_at)
        changed_repeat = self.client.post(
            f"/api/stages/{stage_id}/complete",
            json={"proofText": "different proof"},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(changed_repeat.status_code, 409)
        self.assertEqual(changed_repeat.get_json()["code"], "stage_completed")
        cannot_edit = self.client.put(
            f"/api/stages/{stage_id}",
            json={"title": "cannot edit"},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(cannot_edit.status_code, 409)

        with patch.object(server, "business_today_key", return_value="2026-07-18"):
            next_stage = self.create_stage(title="Next phase", description="Now allowed")
        self.assertEqual(next_stage.status_code, 201)
        self.assertNotEqual(next_stage.get_json()["stage"]["id"], stage_id)

    def test_stage_completion_requires_proof_and_validates_http_evidence_links(self):
        self.login_unlocked_owner()
        with patch.object(server, "business_today_key", return_value="2026-04-01"):
            stage_id = self.create_stage().get_json()["stage"]["id"]

        missing = self.client.post(
            f"/api/stages/{stage_id}/complete",
            json={},
            headers={"X-CSRF-Token": self.csrf()},
        )
        self.assertEqual(missing.status_code, 400)
        for invalid_url in (
            "ftp://example.test/proof",
            "https://user:password@example.test/proof",
            "https://example.test/contains a space",
            "https://example.test/" + "x" * server.MAX_STAGE_PROOF_URL_LENGTH,
        ):
            response = self.client.post(
                f"/api/stages/{stage_id}/complete",
                json={"proofUrl": invalid_url},
                headers={"X-CSRF-Token": self.csrf()},
            )
            self.assertEqual(response.status_code, 400, invalid_url[:80])

        evidence_url = "http://evidence.example.test/result?id=42"
        with patch.object(server, "business_today_key", return_value="2026-04-01"):
            completed = self.client.post(
                f"/api/stages/{stage_id}/complete",
                json={"proofUrl": evidence_url},
                headers={"X-CSRF-Token": self.csrf()},
            )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.get_json()["stage"]["proofUrl"], evidence_url)
        self.assertEqual(completed.get_json()["stage"]["durationDays"], 1)

        with patch.object(server, "business_today_key", return_value="2026-04-02"):
            second_id = self.create_stage(title="HTTPS proof", description="Second").get_json()["stage"]["id"]
            https_completed = self.client.post(
                f"/api/stages/{second_id}/complete",
                json={"proofUrl": "https://evidence.example.test/secure-result"},
                headers={"X-CSRF-Token": self.csrf()},
            )
        self.assertEqual(https_completed.status_code, 200)
        self.assertTrue(https_completed.get_json()["stage"]["proofUrl"].startswith("https://"))

    def test_stage_image_proof_is_reencoded_and_public_to_logged_in_viewers_only(self):
        owner_client = server.app.test_client()
        self.login_unlocked_owner(owner_client)
        with patch.object(server, "business_today_key", return_value="2026-05-10"):
            stage_id = self.create_stage(
                owner_client,
                title="Image evidence phase",
                description="Upload proof",
            ).get_json()["stage"]["id"]

        invalid_image = owner_client.post(
            f"/api/stages/{stage_id}/complete",
            data={"image": (io.BytesIO(b"not an image"), "bad.jpg")},
            headers={"X-CSRF-Token": self.csrf(owner_client)},
        )
        self.assertEqual(invalid_image.status_code, 400)
        self.assertEqual(invalid_image.get_json()["code"], "invalid_attachment")

        with patch.object(server, "business_today_key", return_value="2026-05-11"):
            completed = owner_client.post(
                f"/api/stages/{stage_id}/complete",
                data={"image": (io.BytesIO(self.png_bytes()), "proof.png")},
                headers={"X-CSRF-Token": self.csrf(owner_client)},
            )
        self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
        stage = completed.get_json()["stage"]
        self.assertEqual(stage["durationDays"], 2)
        self.assertRegex(stage["proofImageUrl"], r"^/api/proofs/[a-f0-9]{32}\.jpg$")
        self.assertEqual(stage["proofFileUrl"], stage["proofImageUrl"])
        self.assertEqual(stage["proofFileName"], "proof.png")
        self.assertEqual(stage["proofFileMime"], "image/jpeg")
        self.assertGreater(stage["proofFileSize"], 0)
        self.assertEqual(len(list(server.UPLOAD_DIR.glob("*.jpg"))), 1)

        idempotent = owner_client.post(
            f"/api/stages/{stage_id}/complete",
            json={},
            headers={"X-CSRF-Token": self.csrf(owner_client)},
        )
        self.assertEqual(idempotent.status_code, 200)
        self.assertTrue(idempotent.get_json()["idempotent"])
        conflicting_upload = owner_client.post(
            f"/api/stages/{stage_id}/complete",
            data={"image": (io.BytesIO(self.png_bytes()), "replacement.png")},
            headers={"X-CSRF-Token": self.csrf(owner_client)},
        )
        self.assertEqual(conflicting_upload.status_code, 409)
        self.assertEqual(conflicting_upload.get_json()["code"], "stage_completed")
        self.assertEqual(len(list(server.UPLOAD_DIR.glob("*.jpg"))), 1)

        owner_proof = owner_client.get(stage["proofImageUrl"])
        self.assertEqual(owner_proof.status_code, 200)
        with server.Image.open(io.BytesIO(owner_proof.data)) as decoded:
            self.assertEqual(decoded.format, "JPEG")
            self.assertEqual(decoded.mode, "RGB")
        owner_proof.close()

        viewer_client = server.app.test_client()
        self.assertEqual(self.register_viewer(viewer_client).status_code, 200)
        collection = viewer_client.get("/api/stages?year=2026")
        self.assertEqual(collection.status_code, 200)
        self.assertIsNone(collection.get_json()["activeStage"])
        self.assertEqual(collection.get_json()["completedStages"][0]["id"], stage_id)
        detail = viewer_client.get(f"/api/stages/{stage_id}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.get_json()["stage"]["proofImageUrl"], stage["proofImageUrl"])
        viewer_proof = viewer_client.get(stage["proofImageUrl"])
        self.assertEqual(viewer_proof.status_code, 200)
        viewer_proof.close()

        forbidden = viewer_client.put(
            f"/api/stages/{stage_id}",
            json={"title": "tampered"},
            headers={"X-CSRF-Token": self.csrf(viewer_client)},
        )
        self.assertEqual(forbidden.status_code, 403)
        anonymous = server.app.test_client()
        self.assertEqual(anonymous.get("/api/stages").status_code, 401)
        self.assertEqual(anonymous.get(f"/api/stages/{stage_id}").status_code, 401)
        self.assertEqual(anonymous.get(stage["proofImageUrl"]).status_code, 401)

        exported = owner_client.get("/api/export")
        export_data = json.loads(exported.get_data(as_text=True))
        self.assertEqual(export_data["stages"][0]["id"], stage_id)
        self.assertEqual(export_data["stages"][0]["completionDate"], "2026-05-11")

    def test_stage_year_index_returns_completion_dates_and_supports_detail_lookup(self):
        self.login_unlocked_owner()
        with patch.object(server, "business_today_key", return_value="2025-12-30"):
            first_id = self.create_stage(title="2025 phase", description="First").get_json()["stage"]["id"]
        with patch.object(server, "business_today_key", return_value="2025-12-31"):
            first_done = self.client.post(
                f"/api/stages/{first_id}/complete",
                json={"proofText": "2025 complete"},
                headers={"X-CSRF-Token": self.csrf()},
            )
        self.assertEqual(first_done.get_json()["stage"]["durationDays"], 2)

        with patch.object(server, "business_today_key", return_value="2026-01-01"):
            second_id = self.create_stage(title="2026 phase", description="Second").get_json()["stage"]["id"]
        with patch.object(server, "business_today_key", return_value="2026-01-02"):
            second_done = self.client.post(
                f"/api/stages/{second_id}/complete",
                json={"proofText": "2026 complete"},
                headers={"X-CSRF-Token": self.csrf()},
            )
        self.assertEqual(second_done.get_json()["stage"]["durationDays"], 2)

        year_2026 = self.client.get("/api/stages?year=2026")
        self.assertEqual(year_2026.status_code, 200)
        self.assertEqual(
            year_2026.get_json()["completionDates"],
            [{"date": "2026-01-02", "stageId": second_id}],
        )
        self.assertEqual(
            [item["id"] for item in year_2026.get_json()["completedStages"]],
            [second_id],
        )
        year_2025 = self.client.get("/api/stages/year/2025")
        self.assertEqual(
            year_2025.get_json()["completionDates"],
            [{"date": "2025-12-31", "stageId": first_id}],
        )
        detail = self.client.get(f"/api/stages/{second_id}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.get_json()["stage"]["title"], "2026 phase")
        self.assertEqual(self.client.get("/api/stages?year=not-a-year").status_code, 400)
        self.assertEqual(self.client.get("/api/stages/year/2019").status_code, 400)
        self.assertEqual(self.client.get("/api/stages/999999").status_code, 404)

    def test_production_secure_mode_sets_secure_cookies_and_hsts(self):
        original = server.COOKIE_SECURE
        server.COOKIE_SECURE = True
        try:
            client = server.app.test_client()
            session = client.get("/api/session", base_url="https://daily-seal.test")
            self.assertEqual(
                session.headers["Strict-Transport-Security"],
                "max-age=31536000; includeSubDomains",
            )
            self.assertIn(
                "; Secure",
                next(
                    line
                    for line in session.headers.getlist("Set-Cookie")
                    if line.startswith("ds_csrf=")
                ),
            )
            login = client.post(
                "/api/login",
                base_url="https://daily-seal.test",
                json={
                    "email": self.OWNER_EMAIL,
                    "password": self.OWNER_TEMP_PASSWORD,
                },
                headers={"X-CSRF-Token": session.get_json()["csrfToken"]},
            )
            self.assertEqual(login.status_code, 200, login.get_data(as_text=True))
            session_cookie = next(
                line
                for line in login.headers.getlist("Set-Cookie")
                if line.startswith("ds_session=")
            )
            self.assertIn("; Secure", session_cookie)
            self.assertIn("HttpOnly", session_cookie)
            self.assertIn("SameSite=Lax", session_cookie)
        finally:
            server.COOKIE_SECURE = original


if __name__ == "__main__":
    unittest.main(verbosity=2)
