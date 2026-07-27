"""Isolated integration coverage for the Day1 multi-workspace backend.

The suite owns a temporary data directory, dynamically imports ``app.py`` only
after the environment is configured, and never touches production data.
"""

from __future__ import annotations

import importlib.util
import io
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
import uuid
from contextlib import closing, contextmanager
from datetime import datetime
from pathlib import Path
from unittest.mock import patch


WORK_DIR = Path(__file__).resolve().parents[1]
APP_PATH = WORK_DIR / "app" / "app.py"
VENDOR_DIR = Path(os.environ.get("DAILY_SEAL_TEST_DEPS", WORK_DIR / "vendor"))

_TEMP_DATA = tempfile.TemporaryDirectory(prefix="day1new-tests-")
os.environ["DAILY_SEAL_DATA_DIR"] = _TEMP_DATA.name
os.environ["DAILY_SEAL_COOKIE_SECURE"] = "0"
os.environ["DAILY_SEAL_REGISTRATION_ENABLED"] = "1"
sys.path.insert(0, str(VENDOR_DIR))

_MODULE_NAME = f"day1new_test_server_{uuid.uuid4().hex}"
_SPEC = importlib.util.spec_from_file_location(_MODULE_NAME, APP_PATH)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - import guard
    raise RuntimeError(f"Unable to import {APP_PATH}")
server = importlib.util.module_from_spec(_SPEC)
sys.modules[_MODULE_NAME] = server
_SPEC.loader.exec_module(server)


class Day1NewApiTests(unittest.TestCase):
    BLUE_EMAIL = "blue@example.test"
    BLUE_PASSWORD = "BlueOwner!123"
    TASK_DATE = "2026-01-15"

    @classmethod
    def setUpClass(cls):
        server.app.config.update(TESTING=True)
        cls.blue_password_hash = server.hash_password(cls.BLUE_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop(_MODULE_NAME, None)
        _TEMP_DATA.cleanup()

    def setUp(self):
        # Reset both the platform database and Blue's legacy content store.
        connection = sqlite3.connect(str(server.DB_PATH))
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.executescript(
                """
                DELETE FROM sessions;
                DELETE FROM auth_events;
                DELETE FROM ip_blocks;
                DELETE FROM space_deletion_jobs;
                DELETE FROM messages;
                DELETE FROM viewer_connections;
                DELETE FROM manager_invites;
                DELETE FROM spaces;
                DELETE FROM platform_meta;
                DELETE FROM stages;
                DELETE FROM task_progress_assets;
                DELETE FROM task_progress;
                DELETE FROM tasks;
                DELETE FROM daily_stats;
                DELETE FROM users;
                """
            )
            connection.execute(
                "INSERT INTO users("
                "email, password_hash, role, display_name, is_platform_admin, "
                "must_change_password, created_at"
                ") VALUES (?, ?, 'owner', 'Blue', 0, 0, ?)",
                (self.BLUE_EMAIL, self.blue_password_hash, server.now_ts()),
            )
            connection.commit()
        finally:
            connection.close()

        if server.SPACES_DIR.exists():
            shutil.rmtree(server.SPACES_DIR)
        server.SPACES_DIR.mkdir(parents=True, exist_ok=True)
        server.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        for path in server.UPLOAD_DIR.iterdir():
            if path.is_file():
                path.unlink()

        server.init_db()
        self.identity_counter = 0
        self.blue = server.app.test_client()
        self.login(self.blue, self.BLUE_EMAIL, self.BLUE_PASSWORD)
        self.blue_space = self.only_owned_space(self.blue)

    @contextmanager
    def platform_db(self):
        connection = sqlite3.connect(str(server.DB_PATH))
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
        finally:
            connection.close()

    def csrf(self, client):
        response = client.get("/api/session")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()["csrfToken"]

    def headers(self, client, space_id=None, csrf=False):
        result = {}
        if space_id:
            result["X-Day1-Space"] = space_id
        if csrf:
            result["X-CSRF-Token"] = self.csrf(client)
        return result

    def login(self, client, email, password):
        response = client.post(
            "/api/login",
            json={"email": email, "password": password},
            headers={"X-CSRF-Token": self.csrf(client)},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response

    def only_owned_space(self, client):
        response = client.get("/api/spaces")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        owned = [
            item for item in response.get_json()["spaces"] if item["access"] == "owner"
        ]
        self.assertEqual(len(owned), 1, response.get_data(as_text=True))
        return owned[0]

    def create_manager_invite(self):
        response = self.blue.post(
            "/api/platform/manager-invites",
            json={"expiresDays": 7},
            headers=self.headers(self.blue, csrf=True),
        )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return response.get_json()["code"], response.get_json()["invite"]

    def next_identity(self, prefix):
        self.identity_counter += 1
        return (
            f"{prefix}{self.identity_counter}@example.test",
            f"{prefix.title()}Pass!{self.identity_counter:03d}",
        )

    def register_manager(
        self,
        label,
        *,
        invite_code=None,
        email=None,
        password=None,
    ):
        if invite_code is None:
            invite_code, _invite = self.create_manager_invite()
        generated_email, generated_password = self.next_identity("manager")
        email = email or generated_email
        password = password or generated_password
        client = server.app.test_client()
        response = client.post(
            "/api/register",
            json={
                "registrationKind": "manager",
                "email": email,
                "password": password,
                "displayName": f"{label} 管理者",
                "spaceName": label,
                "managerInviteCode": invite_code,
            },
            headers={"X-CSRF-Token": self.csrf(client)},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        space = self.only_owned_space(client)
        return {
            "client": client,
            "email": email,
            "password": password,
            "space": space,
            "inviteCode": invite_code,
        }

    def viewer_code(self, manager):
        response = manager["client"].get(
            "/api/spaces/current/viewer-code",
            headers=self.headers(
                manager["client"], manager["space"]["publicId"]
            ),
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()["viewerCode"]

    def register_viewer(self, viewer_code, label="visitor"):
        email, password = self.next_identity(label)
        client = server.app.test_client()
        response = client.post(
            "/api/register",
            json={
                "registrationKind": "viewer",
                "email": email,
                "password": password,
                "displayName": f"{label.title()} {self.identity_counter}",
                "viewerCode": viewer_code,
            },
            headers={"X-CSRF-Token": self.csrf(client)},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return {"client": client, "email": email, "password": password}

    def connect_viewer(self, viewer, viewer_code):
        response = viewer["client"].post(
            "/api/spaces/connect",
            json={"viewerCode": viewer_code},
            headers=self.headers(viewer["client"], csrf=True),
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response

    def create_ip_block(self, ip, note="", *, remote_addr=None):
        options = {}
        if remote_addr is not None:
            options["environ_base"] = {"REMOTE_ADDR": remote_addr}
        response = self.blue.post(
            "/api/platform/ip-blocks",
            json={"ip": ip, "note": note},
            headers=self.headers(self.blue, csrf=True),
            **options,
        )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return response.get_json()["block"]

    def delete_ip_block(self, block_id, *, remote_addr=None):
        options = {}
        if remote_addr is not None:
            options["environ_base"] = {"REMOTE_ADDR": remote_addr}
        response = self.blue.delete(
            f"/api/platform/ip-blocks/{block_id}",
            headers=self.headers(self.blue, csrf=True),
            **options,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response

    def put_task(self, manager, text, task_date=None):
        task_date = task_date or self.TASK_DATE
        response = manager["client"].put(
            f"/api/tasks/{task_date}",
            json={"text": text},
            headers=self.headers(
                manager["client"], manager["space"]["publicId"], csrf=True
            ),
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response

    def put_stats(self, manager, poms, note, distractions, stat_date=None):
        stat_date = stat_date or self.TASK_DATE
        response = manager["client"].put(
            f"/api/stats/{stat_date}",
            json={
                "poms": poms,
                "note": note,
                "distractions": distractions,
            },
            headers=self.headers(
                manager["client"], manager["space"]["publicId"], csrf=True
            ),
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response

    def get_data(self, actor, space_id):
        return actor["client"].get(
            "/api/data",
            headers=self.headers(actor["client"], space_id),
        )

    def upload_progress_file(self, manager, raw, original_name):
        self.put_task(manager, f"Attachment task for {manager['space']['name']}")
        progress_response = manager["client"].post(
            f"/api/tasks/{self.TASK_DATE}/progress",
            json={
                "note": "Attachment checkpoint",
                "progressPercent": 35,
                "links": [],
            },
            headers=self.headers(
                manager["client"], manager["space"]["publicId"], csrf=True
            ),
        )
        self.assertEqual(
            progress_response.status_code,
            201,
            progress_response.get_data(as_text=True),
        )
        progress_id = progress_response.get_json()["progress"]["id"]
        upload_response = manager["client"].post(
            f"/api/tasks/{self.TASK_DATE}/progress/{progress_id}/files",
            data={"attachment": (io.BytesIO(raw), original_name)},
            headers=self.headers(
                manager["client"], manager["space"]["publicId"], csrf=True
            ),
        )
        self.assertEqual(
            upload_response.status_code,
            201,
            upload_response.get_data(as_text=True),
        )
        return upload_response.get_json()["asset"]

    def space_row(self, public_id):
        with self.platform_db() as connection:
            row = connection.execute(
                "SELECT * FROM spaces WHERE public_id = ?", (public_id,)
            ).fetchone()
        self.assertIsNotNone(row)
        return row

    def user_id(self, email):
        with self.platform_db() as connection:
            row = connection.execute(
                "SELECT id FROM users WHERE email = ?", (email,)
            ).fetchone()
        self.assertIsNotNone(row)
        return row["id"]

    @staticmethod
    def response_task_texts(response):
        return [item["text"] for item in response.get_json()["tasks"]]

    @staticmethod
    def message_bodies(response):
        return [item["body"] for item in response.get_json()["messages"]]

    @staticmethod
    def cst_timestamp(hour, minute, second):
        today = server.business_now().date()
        value = datetime(
            today.year,
            today.month,
            today.day,
            hour,
            minute,
            second,
            tzinfo=server.SHANGHAI_TIMEZONE,
        )
        return int(value.timestamp())

    def test_blue_exclusively_issues_one_time_manager_invites_and_provisions_storage(self):
        anonymous = server.app.test_client()
        anonymous_attempt = anonymous.post(
            "/api/platform/manager-invites",
            json={},
            headers={"X-CSRF-Token": self.csrf(anonymous)},
        )
        self.assertEqual(anonymous_attempt.status_code, 401)

        blue_viewer_code_response = self.blue.get(
            "/api/spaces/current/viewer-code",
            headers=self.headers(self.blue, self.blue_space["publicId"]),
        )
        self.assertEqual(blue_viewer_code_response.status_code, 200)
        viewer = self.register_viewer(
            blue_viewer_code_response.get_json()["viewerCode"],
            "inviteviewer",
        )
        viewer_attempt = viewer["client"].post(
            "/api/platform/manager-invites",
            json={},
            headers=self.headers(viewer["client"], csrf=True),
        )
        self.assertEqual(viewer_attempt.status_code, 404)
        self.assertEqual(viewer_attempt.get_json()["code"], "not_found")

        invite_code, invite = self.create_manager_invite()
        manager = self.register_manager("独立管理端", invite_code=invite_code)
        manager_attempt = manager["client"].post(
            "/api/platform/manager-invites",
            json={},
            headers=self.headers(manager["client"], csrf=True),
        )
        self.assertEqual(manager_attempt.status_code, 404)
        self.assertEqual(manager_attempt.get_json()["code"], "not_found")

        space_row = self.space_row(manager["space"]["publicId"])
        content_path, upload_dir = server.space_storage_paths(space_row)
        self.assertTrue(content_path.is_file())
        self.assertTrue(upload_dir.is_dir())
        self.assertNotEqual(content_path, server.DB_PATH)
        self.assertTrue(str(content_path).startswith(str(server.SPACES_DIR)))
        with closing(sqlite3.connect(str(content_path))) as content:
            tables = {
                row[0]
                for row in content.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
        self.assertTrue(
            {"tasks", "task_progress", "task_progress_assets", "daily_stats", "stages"}
            .issubset(tables)
        )
        self.assertTrue({"users", "sessions", "spaces", "messages"}.isdisjoint(tables))

        with self.platform_db() as connection:
            manager_user = connection.execute(
                "SELECT role, is_platform_admin FROM users WHERE email = ?",
                (manager["email"],),
            ).fetchone()
            consumed_invite = connection.execute(
                "SELECT used_at, used_by_user_id FROM manager_invites WHERE id = ?",
                (invite["id"],),
            ).fetchone()
            spaces_before_replay = connection.execute(
                "SELECT COUNT(*) FROM spaces"
            ).fetchone()[0]
        self.assertEqual(manager_user["role"], "owner")
        self.assertEqual(manager_user["is_platform_admin"], 0)
        self.assertIsNotNone(consumed_invite["used_at"])
        self.assertEqual(
            consumed_invite["used_by_user_id"], self.user_id(manager["email"])
        )

        replay_client = server.app.test_client()
        replay = replay_client.post(
            "/api/register",
            json={
                "registrationKind": "manager",
                "email": "replay@example.test",
                "password": "ReplayPass!123",
                "displayName": "Replay",
                "spaceName": "Replay space",
                "managerInviteCode": invite_code,
            },
            headers={"X-CSRF-Token": self.csrf(replay_client)},
        )
        self.assertIn(replay.status_code, {403, 409})
        with self.platform_db() as connection:
            self.assertIsNone(
                connection.execute(
                    "SELECT id FROM users WHERE email = 'replay@example.test'"
                ).fetchone()
            )
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM spaces").fetchone()[0],
                spaces_before_replay,
            )

    def test_manager_content_is_isolated_and_blue_preview_is_public_read_only(self):
        manager_a = self.register_manager("空间 A")
        manager_b = self.register_manager("空间 B")
        self.put_task(manager_a, "A 的同日期任务")
        self.put_task(manager_b, "B 的同日期任务")
        self.put_stats(manager_a, 3, "A 私人便签", "A 私人分心")
        self.put_stats(manager_b, 7, "B 私人便签", "B 私人分心")

        data_a = self.get_data(manager_a, manager_a["space"]["publicId"])
        data_b = self.get_data(manager_b, manager_b["space"]["publicId"])
        self.assertEqual(self.response_task_texts(data_a), ["A 的同日期任务"])
        self.assertEqual(self.response_task_texts(data_b), ["B 的同日期任务"])
        self.assertEqual(
            data_a.get_json()["stats"][self.TASK_DATE]["note"], "A 私人便签"
        )
        self.assertEqual(
            data_b.get_json()["stats"][self.TASK_DATE]["note"], "B 私人便签"
        )

        manager_a_read_b = self.get_data(
            manager_a, manager_b["space"]["publicId"]
        )
        self.assertEqual(manager_a_read_b.status_code, 404)
        manager_a_write_b = manager_a["client"].put(
            f"/api/tasks/{self.TASK_DATE}",
            json={"text": "越权覆盖"},
            headers=self.headers(
                manager_a["client"], manager_b["space"]["publicId"], csrf=True
            ),
        )
        self.assertEqual(manager_a_write_b.status_code, 404)

        blue_preview = self.blue.get(
            "/api/data",
            headers=self.headers(self.blue, manager_b["space"]["publicId"]),
        )
        self.assertEqual(
            blue_preview.status_code, 200, blue_preview.get_data(as_text=True)
        )
        preview_payload = blue_preview.get_json()
        self.assertEqual(preview_payload["access"], "platform_preview")
        self.assertEqual(self.response_task_texts(blue_preview), ["B 的同日期任务"])
        self.assertNotIn("stats", preview_payload)
        self.assertEqual(preview_payload["publicPoms"], {self.TASK_DATE: 7})
        preview_text = repr(preview_payload)
        self.assertNotIn("B 私人便签", preview_text)
        self.assertNotIn("B 私人分心", preview_text)

        blue_write = self.blue.put(
            f"/api/tasks/{self.TASK_DATE}",
            json={"text": "Blue 不可修改别人"},
            headers=self.headers(
                self.blue, manager_b["space"]["publicId"], csrf=True
            ),
        )
        self.assertEqual(blue_write.status_code, 403)
        self.assertEqual(blue_write.get_json()["code"], "read_only")
        after = self.get_data(manager_b, manager_b["space"]["publicId"])
        self.assertEqual(self.response_task_texts(after), ["B 的同日期任务"])

        row_a = self.space_row(manager_a["space"]["publicId"])
        row_b = self.space_row(manager_b["space"]["publicId"])
        path_a, _uploads_a = server.space_storage_paths(row_a)
        path_b, _uploads_b = server.space_storage_paths(row_b)
        self.assertNotEqual(path_a, path_b)
        with closing(sqlite3.connect(str(path_a))) as content_a:
            self.assertEqual(
                content_a.execute(
                    "SELECT text FROM tasks WHERE task_date = ?", (self.TASK_DATE,)
                ).fetchone()[0],
                "A 的同日期任务",
            )
        with closing(sqlite3.connect(str(path_b))) as content_b:
            self.assertEqual(
                content_b.execute(
                    "SELECT text FROM tasks WHERE task_date = ?", (self.TASK_DATE,)
                ).fetchone()[0],
                "B 的同日期任务",
            )

    def test_visitor_connects_multiple_spaces_and_switches_by_explicit_space(self):
        manager_a = self.register_manager("切换空间 A")
        manager_b = self.register_manager("切换空间 B")
        self.put_task(manager_a, "访客看到 A")
        self.put_task(manager_b, "访客看到 B")
        code_a = self.viewer_code(manager_a)
        code_b = self.viewer_code(manager_b)

        visitor = self.register_viewer(code_a, "switcher")
        connected = self.connect_viewer(visitor, code_b)
        self.assertEqual(connected.get_json()["space"]["publicId"], manager_b["space"]["publicId"])

        listed = visitor["client"].get("/api/spaces")
        self.assertEqual(listed.status_code, 200)
        spaces = {
            item["publicId"]: item for item in listed.get_json()["spaces"]
        }
        self.assertEqual(
            set(spaces),
            {manager_a["space"]["publicId"], manager_b["space"]["publicId"]},
        )
        self.assertTrue(all(item["access"] == "viewer" for item in spaces.values()))
        self.assertTrue(
            all(item["connectionStatus"] == "active" for item in spaces.values())
        )

        data_a = self.get_data(visitor, manager_a["space"]["publicId"])
        data_b = self.get_data(visitor, manager_b["space"]["publicId"])
        self.assertEqual(data_a.status_code, 200)
        self.assertEqual(data_b.status_code, 200)
        self.assertEqual(self.response_task_texts(data_a), ["访客看到 A"])
        self.assertEqual(self.response_task_texts(data_b), ["访客看到 B"])
        self.assertEqual(
            data_a.get_json()["workspace"]["publicId"],
            manager_a["space"]["publicId"],
        )
        self.assertEqual(
            data_b.get_json()["workspace"]["publicId"],
            manager_b["space"]["publicId"],
        )

    def test_viewer_code_refresh_requires_exact_confirmation_and_revokes_every_connection(self):
        manager_a = self.register_manager("刷新空间 A")
        manager_b = self.register_manager("保留空间 B")
        self.put_task(manager_a, "A 仍在")
        self.put_task(manager_b, "B 不受刷新影响")
        old_code_a = self.viewer_code(manager_a)
        code_b = self.viewer_code(manager_b)
        visitor_one = self.register_viewer(old_code_a, "refreshone")
        self.connect_viewer(visitor_one, code_b)
        visitor_two = self.register_viewer(old_code_a, "refreshtwo")

        code_status = manager_a["client"].get(
            "/api/spaces/current/viewer-code",
            headers=self.headers(
                manager_a["client"], manager_a["space"]["publicId"]
            ),
        )
        self.assertEqual(code_status.get_json()["activeConnections"], 2)

        wrong_confirmation = manager_a["client"].post(
            "/api/spaces/current/viewer-code/refresh",
            json={
                "confirmation": server.VIEWER_CODE_REFRESH_CONFIRMATION + " "
            },
            headers=self.headers(
                manager_a["client"], manager_a["space"]["publicId"], csrf=True
            ),
        )
        self.assertEqual(wrong_confirmation.status_code, 400)
        self.assertEqual(
            wrong_confirmation.get_json()["code"], "confirmation_required"
        )
        self.assertEqual(
            self.get_data(visitor_one, manager_a["space"]["publicId"]).status_code,
            200,
        )

        refreshed = manager_a["client"].post(
            "/api/spaces/current/viewer-code/refresh",
            json={"confirmation": server.VIEWER_CODE_REFRESH_CONFIRMATION},
            headers=self.headers(
                manager_a["client"], manager_a["space"]["publicId"], csrf=True
            ),
        )
        self.assertEqual(refreshed.status_code, 200, refreshed.get_data(as_text=True))
        refresh_payload = refreshed.get_json()
        new_code_a = refresh_payload["viewerCode"]
        self.assertNotEqual(new_code_a, old_code_a)
        self.assertEqual(refresh_payload["disconnectedConnections"], 2)
        self.assertEqual(refresh_payload["activeConnections"], 0)

        for visitor in (visitor_one, visitor_two):
            revoked = self.get_data(visitor, manager_a["space"]["publicId"])
            self.assertEqual(revoked.status_code, 410)
            self.assertEqual(revoked.get_json()["code"], "preview_access_revoked")
            self.assertIn("刷新识别码", revoked.get_json()["error"])

        still_connected_b = self.get_data(
            visitor_one, manager_b["space"]["publicId"]
        )
        self.assertEqual(still_connected_b.status_code, 200)
        self.assertEqual(
            self.response_task_texts(still_connected_b), ["B 不受刷新影响"]
        )

        old_code_attempt = visitor_one["client"].post(
            "/api/spaces/connect",
            json={"viewerCode": old_code_a},
            headers=self.headers(visitor_one["client"], csrf=True),
        )
        self.assertEqual(old_code_attempt.status_code, 403)
        self.assertEqual(
            old_code_attempt.get_json()["code"], "invalid_viewer_code"
        )

        reconnect = self.connect_viewer(visitor_one, new_code_a)
        self.assertEqual(reconnect.get_json()["space"]["connectionStatus"], "active")
        restored = self.get_data(visitor_one, manager_a["space"]["publicId"])
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(self.response_task_texts(restored), ["A 仍在"])

        still_revoked = self.get_data(visitor_two, manager_a["space"]["publicId"])
        self.assertEqual(still_revoked.status_code, 410)
        visitor_two_spaces = visitor_two["client"].get("/api/spaces").get_json()["spaces"]
        revoked_entry = next(
            item
            for item in visitor_two_spaces
            if item["publicId"] == manager_a["space"]["publicId"]
        )
        self.assertEqual(revoked_entry["connectionStatus"], "revoked")
        self.assertIn("刷新识别码", revoked_entry["revokedReason"])

    def test_platform_overview_is_allowlisted_and_only_blue_controls_mascots(self):
        manager = self.register_manager("概览管理端")
        manager_code = self.viewer_code(manager)
        visitor = self.register_viewer(manager_code, "overviewvisitor")
        _unused_code, _unused_invite = self.create_manager_invite()

        overview = self.blue.get("/api/platform/overview")
        self.assertEqual(overview.status_code, 200, overview.get_data(as_text=True))
        payload = overview.get_json()
        self.assertEqual(
            set(payload),
            {"ok", "counts", "spaces", "users", "managerInvites"},
        )
        self.assertEqual(
            set(payload["counts"]),
            {
                "managerCount",
                "activeSessionCount",
                "signedInUserCount",
                "connectedViewerCount",
            },
        )
        self.assertEqual(payload["counts"]["managerCount"], 2)
        self.assertGreaterEqual(payload["counts"]["signedInUserCount"], 3)
        self.assertEqual(payload["counts"]["connectedViewerCount"], 1)

        expected_space_fields = {
            "publicId",
            "name",
            "owner",
            "visitorCount",
            "lastLoginAt",
            "createdAt",
            "previewPermission",
            "appearance",
            "isBlueSpace",
        }
        expected_user_fields = {
            "id",
            "displayName",
            "email",
            "role",
            "isPlatformAdmin",
            "ownedSpace",
            "previewSpaces",
            "activeSessions",
            "createdAt",
            "lastLoginAt",
        }
        expected_invite_fields = {
            "id",
            "hint",
            "status",
            "createdAt",
            "expiresAt",
            "usedAt",
        }
        self.assertTrue(
            all(set(item) == expected_space_fields for item in payload["spaces"])
        )
        self.assertTrue(
            all(set(item["owner"]) == {"displayName", "email"} for item in payload["spaces"])
        )
        self.assertTrue(
            all(set(item) == expected_user_fields for item in payload["users"])
        )
        self.assertTrue(
            all(
                set(preview) == {"publicId", "name", "status", "permission"}
                for item in payload["users"]
                for preview in item["previewSpaces"]
            )
        )
        self.assertTrue(
            all(
                set(item) == expected_invite_fields
                for item in payload["managerInvites"]
            )
        )
        raw_overview = overview.get_data(as_text=True)
        for forbidden in (
            "password_hash",
            "viewer_secret",
            "viewer_code_hash",
            "storage_key",
            "csrf_token",
            "token_hash",
        ):
            self.assertNotIn(forbidden, raw_overview)

        manager_space = next(
            item
            for item in payload["spaces"]
            if item["publicId"] == manager["space"]["publicId"]
        )
        self.assertFalse(manager_space["appearance"]["mascotEnabled"])

        manager_attempt = manager["client"].post(
            f"/api/platform/spaces/{manager['space']['publicId']}/mascot",
            json={"enabled": True},
            headers=self.headers(manager["client"], csrf=True),
        )
        visitor_attempt = visitor["client"].post(
            f"/api/platform/spaces/{manager['space']['publicId']}/mascot",
            json={"enabled": True},
            headers=self.headers(visitor["client"], csrf=True),
        )
        self.assertEqual(manager_attempt.status_code, 404)
        self.assertEqual(visitor_attempt.status_code, 404)

        enabled = self.blue.post(
            f"/api/platform/spaces/{manager['space']['publicId']}/mascot",
            json={"enabled": True},
            headers=self.headers(self.blue, csrf=True),
        )
        self.assertEqual(enabled.status_code, 200, enabled.get_data(as_text=True))
        self.assertTrue(
            enabled.get_json()["space"]["appearance"]["mascotEnabled"]
        )
        manager_spaces = manager["client"].get("/api/spaces").get_json()["spaces"]
        self.assertTrue(manager_spaces[0]["appearance"]["mascotEnabled"])
        blue_spaces = self.blue.get("/api/spaces").get_json()["spaces"]
        self.assertTrue(blue_spaces[0]["appearance"]["mascotEnabled"])

    def test_space_deletion_permissions_confirmation_protection_and_target_binding(self):
        manager_a = self.register_manager("delete-a")
        manager_b = self.register_manager("delete-b")
        code_a = self.viewer_code(manager_a)
        viewer = self.register_viewer(code_a, "deleteviewer")
        self.connect_viewer(viewer, code_a)

        public_a = manager_a["space"]["publicId"]
        public_b = manager_b["space"]["publicId"]
        row_a = self.space_row(public_a)
        row_b = self.space_row(public_b)
        root_a = server.SPACES_DIR / row_a["storage_key"]
        root_b = server.SPACES_DIR / row_b["storage_key"]
        confirmation_a = server.space_delete_confirmation(manager_a["space"]["name"])
        confirmation_b = server.space_delete_confirmation(manager_b["space"]["name"])

        anonymous = server.app.test_client()
        denied_anonymous = anonymous.delete(
            f"/api/platform/spaces/{public_a}",
            json={"confirmation": confirmation_a},
        )
        self.assertEqual(denied_anonymous.status_code, 401)

        denied_viewer = viewer["client"].delete(
            f"/api/platform/spaces/{public_a}",
            json={"confirmation": confirmation_a},
            headers=self.headers(viewer["client"], csrf=True),
        )
        denied_manager = manager_a["client"].delete(
            f"/api/platform/spaces/{public_b}",
            json={"confirmation": confirmation_b},
            headers=self.headers(manager_a["client"], csrf=True),
        )
        self.assertEqual(denied_viewer.status_code, 404)
        self.assertEqual(denied_manager.status_code, 404)

        missing = self.blue.delete(
            "/api/platform/spaces/missing-space",
            json={"confirmation": "irrelevant"},
            headers=self.headers(self.blue, csrf=True),
        )
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.get_json()["code"], "not_found")

        protect_platform_blue = self.blue.delete(
            f"/api/platform/spaces/{self.blue_space['publicId']}",
            json={
                "confirmation": server.space_delete_confirmation(
                    self.blue_space["name"]
                )
            },
            headers=self.headers(self.blue, csrf=True),
        )
        protect_blue_self = self.blue.delete(
            "/api/spaces/current",
            json={
                "confirmation": server.space_delete_confirmation(
                    self.blue_space["name"]
                )
            },
            headers=self.headers(
                self.blue, self.blue_space["publicId"], csrf=True
            ),
        )
        for response in (protect_platform_blue, protect_blue_self):
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.get_json()["code"], "blue_space_protected")

        missing_csrf = manager_a["client"].delete(
            "/api/spaces/current",
            json={"confirmation": confirmation_a},
            headers=self.headers(manager_a["client"], public_a),
        )
        self.assertEqual(missing_csrf.status_code, 403)
        self.assertEqual(missing_csrf.get_json()["code"], "csrf_failed")

        inexact = manager_a["client"].delete(
            "/api/spaces/current",
            json={"confirmation": confirmation_a + " "},
            headers=self.headers(manager_a["client"], public_a, csrf=True),
        )
        self.assertEqual(inexact.status_code, 400)
        self.assertEqual(inexact.get_json()["code"], "confirmation_required")

        wrong_current_space = manager_a["client"].delete(
            "/api/spaces/current",
            json={"confirmation": confirmation_a},
            headers=self.headers(manager_a["client"], public_b, csrf=True),
        )
        self.assertEqual(wrong_current_space.status_code, 404)

        wrong_target_phrase = self.blue.delete(
            f"/api/platform/spaces/{public_b}",
            json={"confirmation": confirmation_a},
            headers=self.headers(self.blue, csrf=True),
        )
        self.assertEqual(wrong_target_phrase.status_code, 400)
        self.assertEqual(
            wrong_target_phrase.get_json()["code"], "confirmation_required"
        )
        self.assertTrue(root_a.is_dir())
        self.assertTrue(root_b.is_dir())

        deleted = self.blue.delete(
            f"/api/platform/spaces/{public_a}",
            json={"confirmation": confirmation_a},
            headers=self.headers(self.blue, csrf=True),
        )
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertEqual(deleted.get_json()["deletedSpace"]["publicId"], public_a)
        self.assertFalse(root_a.exists())
        self.assertTrue(root_b.is_dir())
        with self.platform_db() as connection:
            self.assertIsNone(
                connection.execute(
                    "SELECT id FROM spaces WHERE public_id = ?", (public_a,)
                ).fetchone()
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM spaces WHERE public_id = ?", (public_b,)
                ).fetchone()
            )

    def test_manager_self_delete_cascades_platform_state_and_only_its_storage(self):
        invite_code, invite = self.create_manager_invite()
        manager_a = self.register_manager(
            "cascade-a",
            invite_code=invite_code,
            email="cascade-a@example.test",
            password="CascadeA!123",
        )
        manager_b = self.register_manager("cascade-b")
        public_a = manager_a["space"]["publicId"]
        public_b = manager_b["space"]["publicId"]
        row_a = self.space_row(public_a)
        row_b = self.space_row(public_b)
        owner_a_id = self.user_id(manager_a["email"])
        owner_b_id = self.user_id(manager_b["email"])

        content_a, uploads_a = server.space_storage_paths(row_a)
        content_b, uploads_b = server.space_storage_paths(row_b)
        marker_a = uploads_a / "delete-me.txt"
        marker_b = uploads_b / "keep-me.txt"
        marker_a.write_text("workspace a", encoding="utf-8")
        marker_b.write_text("workspace b", encoding="utf-8")
        self.put_task(manager_a, "delete only workspace a")
        self.put_task(manager_b, "keep workspace b")

        code_a = self.viewer_code(manager_a)
        code_b = self.viewer_code(manager_b)
        visitor = self.register_viewer(code_a, "cascadeviewer")
        visitor_id = self.user_id(visitor["email"])
        self.connect_viewer(visitor, code_b)
        for public_id, body in (
            (public_a, "message in workspace a"),
            (public_b, "message in workspace b"),
        ):
            response = visitor["client"].post(
                "/api/messages",
                json={"body": body},
                headers=self.headers(visitor["client"], public_id, csrf=True),
            )
            self.assertEqual(response.status_code, 201, response.get_data(as_text=True))

        second_manager_session = server.app.test_client()
        self.login(
            second_manager_session,
            manager_a["email"],
            manager_a["password"],
        )
        unrelated_block = self.create_ip_block(
            "198.51.100.91", "must survive workspace deletion"
        )

        with self.platform_db() as connection:
            self.assertGreaterEqual(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?",
                    (owner_a_id,),
                ).fetchone()["count"],
                2,
            )
            self.assertGreater(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM auth_events "
                    "WHERE email = ? COLLATE NOCASE",
                    (manager_a["email"],),
                ).fetchone()["count"],
                0,
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM manager_invites WHERE id = ? "
                    "AND used_by_user_id = ?",
                    (invite["id"], owner_a_id),
                ).fetchone()
            )

        deleted = manager_a["client"].delete(
            "/api/spaces/current",
            json={
                "confirmation": server.space_delete_confirmation(
                    manager_a["space"]["name"]
                )
            },
            headers=self.headers(manager_a["client"], public_a, csrf=True),
        )
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertTrue(deleted.get_json()["deletedSpace"]["storageCleaned"])
        self.assertTrue(
            any(
                cookie.startswith(f"{server.SESSION_COOKIE}=")
                and ("Max-Age=0" in cookie or "Expires=Thu, 01 Jan 1970" in cookie)
                for cookie in deleted.headers.getlist("Set-Cookie")
            )
        )

        with self.platform_db() as connection:
            self.assertIsNone(
                connection.execute(
                    "SELECT id FROM users WHERE id = ?", (owner_a_id,)
                ).fetchone()
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM users WHERE id = ?", (owner_b_id,)
                ).fetchone()
            )
            self.assertIsNone(
                connection.execute(
                    "SELECT id FROM spaces WHERE id = ?", (row_a["id"],)
                ).fetchone()
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM spaces WHERE id = ?", (row_b["id"],)
                ).fetchone()
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?",
                    (owner_a_id,),
                ).fetchone()["count"],
                0,
            )
            self.assertIsNone(
                connection.execute(
                    "SELECT id FROM manager_invites WHERE id = ?", (invite["id"],)
                ).fetchone()
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM auth_events "
                    "WHERE email = ? COLLATE NOCASE",
                    (manager_a["email"],),
                ).fetchone()["count"],
                0,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM viewer_connections "
                    "WHERE space_id = ?",
                    (row_a["id"],),
                ).fetchone()["count"],
                0,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM messages WHERE space_id = ?",
                    (row_a["id"],),
                ).fetchone()["count"],
                0,
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM viewer_connections "
                    "WHERE space_id = ? AND user_id = ?",
                    (row_b["id"], visitor_id),
                ).fetchone()
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM messages WHERE space_id = ? AND body = ?",
                    (row_b["id"], "message in workspace b"),
                ).fetchone()
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM ip_blocks WHERE id = ?",
                    (unrelated_block["id"],),
                ).fetchone()
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM space_deletion_jobs"
                ).fetchone()["count"],
                0,
            )

        self.assertFalse(content_a.exists())
        self.assertFalse(marker_a.exists())
        self.assertTrue(content_b.is_file())
        self.assertEqual(marker_b.read_text(encoding="utf-8"), "workspace b")
        manager_b_data = self.get_data(manager_b, public_b)
        visitor_b_data = self.get_data(visitor, public_b)
        self.assertEqual(manager_b_data.status_code, 200)
        self.assertEqual(visitor_b_data.status_code, 200)
        self.assertEqual(
            self.response_task_texts(manager_b_data), ["keep workspace b"]
        )

        stale_session = second_manager_session.get("/api/session")
        self.assertEqual(stale_session.status_code, 200)
        self.assertFalse(stale_session.get_json()["authenticated"])
        stale_data = second_manager_session.get(
            "/api/data", headers={"X-Day1-Space": public_a}
        )
        self.assertEqual(stale_data.status_code, 401)

    def test_space_delete_rename_failure_rolls_back_without_partial_deletion(self):
        invite_code, invite = self.create_manager_invite()
        manager = self.register_manager(
            "rename-failure",
            invite_code=invite_code,
            email="rename-failure@example.test",
            password="RenameFailure!123",
        )
        public_id = manager["space"]["publicId"]
        row = self.space_row(public_id)
        owner_id = self.user_id(manager["email"])
        content_path, uploads = server.space_storage_paths(row)
        marker = uploads / "still-here.txt"
        marker.write_text("preserved", encoding="utf-8")
        self.put_task(manager, "task survives failed rename")
        request_headers = self.headers(manager["client"], public_id, csrf=True)

        with patch.object(
            server.os, "replace", side_effect=OSError("injected rename failure")
        ):
            response = manager["client"].delete(
                "/api/spaces/current",
                json={
                    "confirmation": server.space_delete_confirmation(
                        manager["space"]["name"]
                    )
                },
                headers=request_headers,
            )
        self.assertEqual(response.status_code, 503, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["code"], "space_delete_failed")

        with self.platform_db() as connection:
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM users WHERE id = ?", (owner_id,)
                ).fetchone()
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM spaces WHERE id = ?", (row["id"],)
                ).fetchone()
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT id FROM manager_invites WHERE id = ? "
                    "AND used_by_user_id = ?",
                    (invite["id"], owner_id),
                ).fetchone()
            )
            self.assertGreater(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM auth_events "
                    "WHERE email = ? COLLATE NOCASE",
                    (manager["email"],),
                ).fetchone()["count"],
                0,
            )
            self.assertGreater(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?",
                    (owner_id,),
                ).fetchone()["count"],
                0,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM space_deletion_jobs"
                ).fetchone()["count"],
                0,
            )

        self.assertTrue(content_path.is_file())
        self.assertEqual(marker.read_text(encoding="utf-8"), "preserved")
        data = self.get_data(manager, public_id)
        self.assertEqual(data.status_code, 200)
        self.assertEqual(
            self.response_task_texts(data), ["task survives failed rename"]
        )

    def test_ip_block_permissions_normalization_and_unblock_contract(self):
        manager = self.register_manager("ip-permissions")
        code = self.viewer_code(manager)
        viewer = self.register_viewer(code, "ipviewer")
        anonymous = server.app.test_client()

        self.assertEqual(
            anonymous.get("/api/platform/ip-access").status_code,
            401,
        )
        for client in (manager["client"], viewer["client"]):
            denied = client.get("/api/platform/ip-access")
            self.assertEqual(denied.status_code, 404)

        missing_csrf = self.blue.post(
            "/api/platform/ip-blocks",
            json={"ip": "198.51.100.30", "note": "no csrf"},
        )
        self.assertEqual(missing_csrf.status_code, 403)
        self.assertEqual(missing_csrf.get_json()["code"], "csrf_failed")

        ipv6 = self.create_ip_block(
            "  2001:0DB8:0000:0000:0000:ff00:0042:8329  ",
            "canonical IPv6",
        )
        self.assertEqual(ipv6["ip"], "2001:db8::ff00:42:8329")
        duplicate = self.blue.post(
            "/api/platform/ip-blocks",
            json={"ip": "2001:db8::ff00:42:8329"},
            headers=self.headers(self.blue, csrf=True),
        )
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(duplicate.get_json()["code"], "ip_already_blocked")

        mapped = self.create_ip_block(
            "::FFFF:192.0.2.128", "IPv4 mapped IPv6"
        )
        self.assertEqual(mapped["ip"], "192.0.2.128")

        for invalid_ip in (
            "fe80::1%eth0",
            "192.0.2.1:443",
            "999.1.1.1",
            "not-an-ip",
        ):
            invalid = self.blue.post(
                "/api/platform/ip-blocks",
                json={"ip": invalid_ip},
                headers=self.headers(self.blue, csrf=True),
            )
            self.assertEqual(
                invalid.status_code, 400, invalid.get_data(as_text=True)
            )
            self.assertEqual(invalid.get_json()["code"], "invalid_ip")

        listing = self.blue.get("/api/platform/ip-access")
        self.assertEqual(listing.status_code, 200, listing.get_data(as_text=True))
        self.assertEqual(
            {item["ip"] for item in listing.get_json()["blocks"]},
            {"2001:db8::ff00:42:8329", "192.0.2.128"},
        )

        denied_delete = manager["client"].delete(
            f"/api/platform/ip-blocks/{ipv6['id']}",
            headers=self.headers(manager["client"], csrf=True),
        )
        self.assertEqual(denied_delete.status_code, 404)
        no_csrf_delete = self.blue.delete(
            f"/api/platform/ip-blocks/{ipv6['id']}"
        )
        self.assertEqual(no_csrf_delete.status_code, 403)
        self.assertEqual(no_csrf_delete.get_json()["code"], "csrf_failed")

        unblocked = self.delete_ip_block(ipv6["id"])
        self.assertEqual(
            unblocked.get_json()["unblockedIp"], "2001:db8::ff00:42:8329"
        )
        listing_after = self.blue.get("/api/platform/ip-access").get_json()
        self.assertNotIn(
            "2001:db8::ff00:42:8329",
            {item["ip"] for item in listing_after["blocks"]},
        )

    def test_ip_block_applies_to_existing_same_ip_viewers_but_not_admins(self):
        manager = self.register_manager("shared-ip")
        public_id = manager["space"]["publicId"]
        code = self.viewer_code(manager)
        viewer_one = self.register_viewer(code, "sharedone")
        viewer_two = self.register_viewer(code, "sharedtwo")
        shared_ip = "203.0.113.44"

        def preview(actor):
            return actor["client"].get(
                "/api/data",
                headers={"X-Day1-Space": public_id},
                environ_base={"REMOTE_ADDR": shared_ip},
            )

        self.assertEqual(preview(viewer_one).status_code, 200)
        self.assertEqual(preview(viewer_two).status_code, 200)
        manager_same_ip = manager["client"].get(
            "/api/data",
            headers={"X-Day1-Space": public_id},
            environ_base={"REMOTE_ADDR": shared_ip},
        )
        self.assertEqual(manager_same_ip.status_code, 200)

        block = self.create_ip_block(
            shared_ip,
            "shared network",
            remote_addr=shared_ip,
        )
        self.assertEqual(block["affectedConnections"], 2)

        for viewer in (viewer_one, viewer_two):
            blocked = preview(viewer)
            self.assertEqual(blocked.status_code, 403)
            self.assertEqual(blocked.get_json()["code"], "visitor_ip_blocked")
            session = viewer["client"].get(
                "/api/session",
                environ_base={"REMOTE_ADDR": shared_ip},
            )
            self.assertTrue(session.get_json()["authenticated"])
            connected_space = next(
                item
                for item in session.get_json()["spaces"]
                if item["publicId"] == public_id
            )
            self.assertEqual(connected_space["connectionStatus"], "blocked")

        manager_still_works = manager["client"].get(
            "/api/data",
            headers={"X-Day1-Space": public_id},
            environ_base={"REMOTE_ADDR": shared_ip},
        )
        blue_still_works = self.blue.get(
            "/api/platform/overview",
            environ_base={"REMOTE_ADDR": shared_ip},
        )
        self.assertEqual(manager_still_works.status_code, 200)
        self.assertEqual(blue_still_works.status_code, 200)

        self.delete_ip_block(block["id"], remote_addr=shared_ip)
        self.assertEqual(preview(viewer_one).status_code, 200)
        self.assertEqual(preview(viewer_two).status_code, 200)

    def test_xff_uses_appended_peer_address_and_cannot_be_left_spoofed(self):
        manager = self.register_manager("xff")
        public_id = manager["space"]["publicId"]
        viewer = self.register_viewer(self.viewer_code(manager), "xffviewer")
        banned_peer = "203.0.113.77"
        unblocked_peer = "198.51.100.77"
        self.create_ip_block(banned_peer, "trusted proxy peer")

        blocked = viewer["client"].get(
            "/api/data",
            headers={
                "X-Day1-Space": public_id,
                "X-Forwarded-For": f"192.0.2.123, {banned_peer}",
                "X-Real-IP": "192.0.2.200",
            },
            environ_base={"REMOTE_ADDR": "10.0.0.9"},
        )
        self.assertEqual(blocked.status_code, 403)
        self.assertEqual(blocked.get_json()["code"], "visitor_ip_blocked")

        spoofed_leftmost_only = viewer["client"].get(
            "/api/data",
            headers={
                "X-Day1-Space": public_id,
                "X-Forwarded-For": f"{banned_peer}, {unblocked_peer}",
                "X-Real-IP": banned_peer,
            },
            environ_base={"REMOTE_ADDR": "10.0.0.9"},
        )
        self.assertEqual(
            spoofed_leftmost_only.status_code,
            200,
            spoofed_leftmost_only.get_data(as_text=True),
        )
        with self.platform_db() as connection:
            last_ip = connection.execute(
                "SELECT last_ip FROM viewer_connections "
                "WHERE user_id = ? AND space_id = ?",
                (self.user_id(viewer["email"]), self.space_row(public_id)["id"]),
            ).fetchone()["last_ip"]
        self.assertEqual(last_ip, unblocked_peer)

    def test_static_delete_and_ip_access_controls_are_wired_and_explained(self):
        static_dir = WORK_DIR / "app" / "static"
        html = (static_dir / "index.html").read_text(encoding="utf-8")
        script = (static_dir / "app.js").read_text(encoding="utf-8")
        styles = (static_dir / "app.css").read_text(encoding="utf-8")

        for element_id in (
            "workspace-danger-zone",
            "open-delete-own-space",
            "platform-access-tab",
            "platform-access-panel",
            "platform-visitor-ip-list",
            "platform-blacklist-count",
            "platform-ip-block-list",
            "open-manual-ip-block",
            "delete-space-dialog",
            "delete-space-form",
            "delete-space-name",
            "delete-space-phrase",
            "delete-space-confirmation",
            "delete-space-submit",
            "ip-block-dialog",
            "ip-block-form",
            "ip-block-address",
            "ip-block-note",
            "ip-block-submit",
        ):
            self.assertIn(f'id="{element_id}"', html)

        for visible_copy in (
            "删除此管理端",
            "无法恢复",
            "完整输入包含端名的确认句",
            "访客 IP 与黑名单",
            "仅限制访客预览",
            "不会影响管理端后台",
            "共享网络可能包含多位访客",
            "永久删除管理端",
            "加入黑名单",
        ):
            self.assertIn(visible_copy, html)

        for script_contract in (
            "open-delete-own-space",
            "delete-space-form",
            "ip-block-form",
            "platform-access",
            "/api/spaces/current",
            "/api/platform/spaces/",
            "/api/platform/ip-access",
            "/api/platform/ip-blocks",
        ):
            self.assertIn(script_contract, script)

        for selector in (
            ".danger-zone-card",
            ".platform-access-grid",
            ".platform-security-list",
            ".button-danger",
        ):
            self.assertIn(selector, styles)

    def test_message_window_boundaries_and_conversations_are_isolated(self):
        manager = self.register_manager("留言空间")
        code = self.viewer_code(manager)
        visitor_one = self.register_viewer(code, "messageone")
        visitor_two = self.register_viewer(code, "messagetwo")
        visitor_one_id = self.user_id(visitor_one["email"])

        at_1959 = self.cst_timestamp(19, 59, 59)
        with patch.object(server, "now_ts", return_value=at_1959):
            first = visitor_one["client"].post(
                "/api/messages",
                json={"body": "仅访客一可见"},
                headers=self.headers(
                    visitor_one["client"],
                    manager["space"]["publicId"],
                    csrf=True,
                ),
            )
            second = visitor_two["client"].post(
                "/api/messages",
                json={"body": "仅访客二可见"},
                headers=self.headers(
                    visitor_two["client"],
                    manager["space"]["publicId"],
                    csrf=True,
                ),
            )
            self.assertEqual(first.status_code, 201, first.get_data(as_text=True))
            self.assertEqual(second.status_code, 201, second.get_data(as_text=True))
            self.assertFalse(first.get_json()["window"]["isOpen"])

            owner_closed = manager["client"].get(
                "/api/messages",
                headers=self.headers(
                    manager["client"], manager["space"]["publicId"]
                ),
            )
            self.assertEqual(owner_closed.status_code, 200)
            self.assertFalse(owner_closed.get_json()["contentAvailable"])
            self.assertEqual(owner_closed.get_json()["conversations"], [])
            reply_closed = manager["client"].post(
                f"/api/messages/{visitor_one_id}/reply",
                json={"body": "还不能回复"},
                headers=self.headers(
                    manager["client"],
                    manager["space"]["publicId"],
                    csrf=True,
                ),
            )
            self.assertEqual(reply_closed.status_code, 403)
            self.assertEqual(
                reply_closed.get_json()["code"], "message_window_closed"
            )

            conversation_one = visitor_one["client"].get(
                "/api/messages",
                headers=self.headers(
                    visitor_one["client"], manager["space"]["publicId"]
                ),
            )
            conversation_two = visitor_two["client"].get(
                "/api/messages",
                headers=self.headers(
                    visitor_two["client"], manager["space"]["publicId"]
                ),
            )
            self.assertEqual(
                self.message_bodies(conversation_one), ["仅访客一可见"]
            )
            self.assertEqual(
                self.message_bodies(conversation_two), ["仅访客二可见"]
            )

            blue_preview = self.blue.get(
                "/api/messages",
                headers=self.headers(self.blue, manager["space"]["publicId"]),
            )
            self.assertEqual(blue_preview.status_code, 404)

        at_2000 = self.cst_timestamp(20, 0, 0)
        with patch.object(server, "now_ts", return_value=at_2000):
            opened = manager["client"].get(
                "/api/messages",
                headers=self.headers(
                    manager["client"], manager["space"]["publicId"]
                ),
            )
            self.assertEqual(opened.status_code, 200)
            self.assertTrue(opened.get_json()["window"]["isOpen"])
            self.assertTrue(
                opened.get_json()["window"]["serverNow"].endswith("20:00:00+08:00")
            )
            self.assertTrue(
                opened.get_json()["window"]["closesAt"].endswith("21:00:00+08:00")
            )
            self.assertTrue(opened.get_json()["contentAvailable"])
            self.assertEqual(len(opened.get_json()["conversations"]), 2)
            reply = manager["client"].post(
                f"/api/messages/{visitor_one_id}/reply",
                json={"body": "20 点回复访客一"},
                headers=self.headers(
                    manager["client"],
                    manager["space"]["publicId"],
                    csrf=True,
                ),
            )
            self.assertEqual(reply.status_code, 201, reply.get_data(as_text=True))
            visitor_one_view = visitor_one["client"].get(
                "/api/messages",
                headers=self.headers(
                    visitor_one["client"], manager["space"]["publicId"]
                ),
            )
            visitor_two_view = visitor_two["client"].get(
                "/api/messages",
                headers=self.headers(
                    visitor_two["client"], manager["space"]["publicId"]
                ),
            )
            self.assertIn("20 点回复访客一", self.message_bodies(visitor_one_view))
            self.assertNotIn(
                "20 点回复访客一", self.message_bodies(visitor_two_view)
            )

        at_2059 = self.cst_timestamp(20, 59, 59)
        with patch.object(server, "now_ts", return_value=at_2059):
            still_open = manager["client"].get(
                "/api/messages",
                headers=self.headers(
                    manager["client"], manager["space"]["publicId"]
                ),
            )
            self.assertTrue(still_open.get_json()["window"]["isOpen"])
            final_open_reply = manager["client"].post(
                f"/api/messages/{visitor_one_id}/reply",
                json={"body": "20:59:59 仍可回复"},
                headers=self.headers(
                    manager["client"],
                    manager["space"]["publicId"],
                    csrf=True,
                ),
            )
            self.assertEqual(final_open_reply.status_code, 201)

        at_2100 = self.cst_timestamp(21, 0, 0)
        with patch.object(server, "now_ts", return_value=at_2100):
            closed = manager["client"].get(
                "/api/messages",
                headers=self.headers(
                    manager["client"], manager["space"]["publicId"]
                ),
            )
            self.assertFalse(closed.get_json()["window"]["isOpen"])
            self.assertFalse(closed.get_json()["contentAvailable"])
            self.assertEqual(closed.get_json()["conversations"], [])
            rejected = manager["client"].post(
                f"/api/messages/{visitor_one_id}/reply",
                json={"body": "21 点后不可回复"},
                headers=self.headers(
                    manager["client"],
                    manager["space"]["publicId"],
                    csrf=True,
                ),
            )
            self.assertEqual(rejected.status_code, 403)
            self.assertEqual(rejected.get_json()["code"], "message_window_closed")
            visitor_history = visitor_one["client"].get(
                "/api/messages",
                headers=self.headers(
                    visitor_one["client"], manager["space"]["publicId"]
                ),
            )
            self.assertIn(
                "20:59:59 仍可回复", self.message_bodies(visitor_history)
            )

    def test_attachment_urls_and_physical_directories_are_space_scoped(self):
        manager_a = self.register_manager("附件空间 A")
        manager_b = self.register_manager("附件空间 B")
        shared_bytes = b"same bytes, isolated by workspace"
        asset_a = self.upload_progress_file(
            manager_a, shared_bytes, "a-evidence.txt"
        )
        asset_b = self.upload_progress_file(
            manager_b, shared_bytes, "b-evidence.txt"
        )
        url_a = asset_a["proofFileUrl"]
        url_b = asset_b["proofFileUrl"]
        self.assertIn(manager_a["space"]["publicId"], url_a)
        self.assertIn(manager_b["space"]["publicId"], url_b)
        self.assertNotEqual(url_a, url_b)

        row_a = self.space_row(manager_a["space"]["publicId"])
        row_b = self.space_row(manager_b["space"]["publicId"])
        _db_a, uploads_a = server.space_storage_paths(row_a)
        _db_b, uploads_b = server.space_storage_paths(row_b)
        files_a = [path for path in uploads_a.iterdir() if path.is_file()]
        files_b = [path for path in uploads_b.iterdir() if path.is_file()]
        self.assertEqual(len(files_a), 1)
        self.assertEqual(len(files_b), 1)
        self.assertNotEqual(uploads_a, uploads_b)
        self.assertEqual(files_a[0].read_bytes(), shared_bytes)
        self.assertEqual(files_b[0].read_bytes(), shared_bytes)
        self.assertEqual(files_a[0].name, url_a.rsplit("/", 1)[-1])
        self.assertEqual(files_b[0].name, url_b.rsplit("/", 1)[-1])

        visitor_a = self.register_viewer(self.viewer_code(manager_a), "filevisitora")
        visitor_b = self.register_viewer(self.viewer_code(manager_b), "filevisitorb")

        allowed_a = visitor_a["client"].get(url_a)
        blocked_a_to_b = visitor_a["client"].get(url_b)
        blocked_manager_a_to_b = manager_a["client"].get(url_b)
        allowed_b = visitor_b["client"].get(url_b)
        blocked_b_to_a = visitor_b["client"].get(url_a)
        blue_a = self.blue.get(url_a)
        blue_b = self.blue.get(url_b)
        try:
            self.assertEqual(allowed_a.status_code, 200)
            self.assertIn("no-store", allowed_a.headers.get("Cache-Control", ""))
            self.assertEqual(blocked_a_to_b.status_code, 404)
            self.assertEqual(blocked_manager_a_to_b.status_code, 404)
            self.assertEqual(allowed_b.status_code, 200)
            self.assertEqual(blocked_b_to_a.status_code, 404)
            self.assertEqual(blue_a.status_code, 200)
            self.assertEqual(blue_b.status_code, 200)
            self.assertEqual(allowed_a.get_data(), shared_bytes)
            self.assertEqual(allowed_b.get_data(), shared_bytes)
        finally:
            for response in (
                allowed_a,
                blocked_a_to_b,
                blocked_manager_a_to_b,
                allowed_b,
                blocked_b_to_a,
                blue_a,
                blue_b,
            ):
                response.close()


if __name__ == "__main__":
    unittest.main()
