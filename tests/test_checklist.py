"""Weighted daily plans: authority, history, midnight and portable records."""
import json
import unittest
from unittest.mock import patch

import test_app as base
from test_app import server


class ChecklistTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.init_db()
        base.DailySealApiTests.setUpClass.__func__(cls)
    setUp = base.DailySealApiTests.setUp
    db = base.DailySealApiTests.db
    csrf = base.DailySealApiTests.csrf
    login_owner = base.DailySealApiTests.login_owner
    unlock_owner = base.DailySealApiTests.unlock_owner
    login_unlocked_owner = base.DailySealApiTests.login_unlocked_owner
    OWNER_EMAIL = base.DailySealApiTests.OWNER_EMAIL
    OWNER_TEMP_PASSWORD = base.DailySealApiTests.OWNER_TEMP_PASSWORD
    DAY = "2026-07-17"
    PLAN = [{"text": "数学练习", "weight": 33}, {"text": "化学复习", "weight": 33}, {"text": "整理错题", "weight": 34}]

    def plan(self, items=None):
        return self.client.put(f"/api/tasks/{self.DAY}", json={"checklist": self.PLAN if items is None else items}, headers={"X-CSRF-Token": self.csrf()})

    def progress(self, checked, revision, key="", **extras):
        return self.client.post(f"/api/tasks/{self.DAY}/progress", json={
            "progressPercent": 100, "checkedItems": checked, "checklistRevision": revision,
            "checklist": self.PLAN,
            "clientRecordId": key or None, **extras,
        }, headers={"X-CSRF-Token": self.csrf()})

    def test_weighted_authority_correction_conflict_and_plan_lock(self):
        self.login_unlocked_owner()
        task = self.plan().get_json()["task"]
        self.assertEqual(task["checklist"], self.PLAN)
        self.assertEqual(self.progress([0], 0, checklist=[{"text": "stale plan", "weight": 100}]).status_code, 409)
        saved = self.progress([0], 0, "checklist-first-record")
        self.assertEqual(saved.status_code, 201, saved.get_data(as_text=True))
        task = saved.get_json()["task"]
        self.assertEqual(task["progressEntries"][-1]["progressPercent"], 33)
        rev = task["checklistRevision"]
        self.assertEqual(self.progress([1], 0).status_code, 409)
        retry = self.progress([0], 0, "checklist-first-record")
        self.assertTrue(retry.get_json()["idempotent"])
        # Equal percentages can still mean different completed items.
        replaced = self.progress([1], rev).get_json()["task"]
        self.assertEqual(replaced["checkedItems"], [1])
        cleared = self.progress([], replaced["checklistRevision"]).get_json()["task"]
        self.assertEqual(cleared["progressEntries"][-1]["progressPercent"], 0)
        self.assertEqual(self.plan([{"text": "Changed", "weight": 100}]).status_code, 409)
        for bad in ([True], [0, 0], [-1], [3], "0"):
            self.assertEqual(self.progress(bad, cleared["checklistRevision"]).status_code, 400)
        manual = self.client.post(f"/api/tasks/{self.DAY}/progress", json={"progressPercent": 100}, headers={"X-CSRF-Token": self.csrf()})
        self.assertEqual(manual.status_code, 400)

    def test_plan_validation(self):
        self.login_unlocked_owner()
        for plan in ([{"text": "", "weight": 100}], [{"text": "X", "weight": 99}], [{"text": "X", "weight": 100.0}], [{"text": "X", "weight": True}], [{"text": "x" * 201, "weight": 100}], [{"text": "X", "weight": 100}] * 21):
            self.assertEqual(self.plan(plan).status_code, 400)

    def test_optional_result_midnight_supplement_and_export_round_trip(self):
        self.login_unlocked_owner()
        self.plan()
        task = self.progress([0], 0).get_json()["task"]
        response = self.client.post(f"/api/tasks/{self.DAY}/result", data={"resultStatus": "completed", "completionPercent": "100", "resultNote": ""}, headers={"X-CSRF-Token": self.csrf()})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["task"]["completionPercent"], 33)
        self.assertEqual(response.get_json()["task"]["resultStatus"], "incomplete")
        task = self.progress([0, 2], task["checklistRevision"]).get_json()["task"]
        server.app.config["BUSINESS_DATE_PROVIDER"] = lambda _hint=None: "2026-07-18"
        frozen = self.client.get("/api/data").get_json()["tasks"][0]
        self.assertEqual(frozen["completionPercent"], 67)
        self.assertTrue(frozen["resultLocked"])
        supplemented = self.progress([0, 1, 2], task["checklistRevision"])
        self.assertEqual(supplemented.status_code, 201)
        final = supplemented.get_json()["task"]
        self.assertEqual(final["completionPercent"], 67)
        self.assertEqual(final["supplementCompletionPercent"], 100)
        exported = json.loads(self.client.get("/api/export").get_data(as_text=True))
        with self.db() as db:
            db.execute("DELETE FROM task_progress")
            db.execute("DELETE FROM tasks")
        imported = self.client.post("/api/import", json={"data": exported}, headers={"X-CSRF-Token": self.csrf()})
        self.assertEqual(imported.status_code, 200, imported.get_data(as_text=True))
        again = self.client.get("/api/data").get_json()["tasks"][0]
        self.assertEqual(again["checklist"], self.PLAN)
        self.assertEqual(again["checkedItems"], [0, 1, 2])
        self.assertEqual(again["completionPercent"], 67)
        server.app.config["BUSINESS_DATE_PROVIDER"] = lambda _hint=None: "2026-07-19"
        self.assertEqual(self.progress([], again["checklistRevision"]).status_code, 409)

    def test_midnight_clock_and_automatic_without_result(self):
        self.login_unlocked_owner()
        self.plan()
        before = int(server.datetime(2026, 7, 17, 23, 59, 59, tzinfo=server.CHINA_STANDARD_TIME).timestamp())
        server.app.config.pop("BUSINESS_DATE_PROVIDER", None)
        with patch.object(server, "now_ts", return_value=before):
            self.assertEqual(self.progress([0, 1, 2], 0).status_code, 201)
        with patch.object(server, "now_ts", return_value=before + 1):
            # business_today_key uses datetime unless a provider is installed.
            server.app.config["BUSINESS_DATE_PROVIDER"] = lambda _hint=None: "2026-07-18"
            task = self.client.get("/api/data").get_json()["tasks"][0]
        self.assertEqual(task["completionPercent"], 100)
        self.assertEqual(task["resultLockSource"], "automatic")

    def test_unchecked_plan_freezes_zero_and_import_keeps_it(self):
        self.login_unlocked_owner()
        self.plan()
        server.app.config["BUSINESS_DATE_PROVIDER"] = lambda _hint=None: "2026-07-18"
        task = self.client.get("/api/data").get_json()["tasks"][0]
        self.assertEqual(task["completionPercent"], 0)
        self.assertEqual(task["resultStatus"], "incomplete")
        self.assertTrue(task["resultLocked"])
        exported = json.loads(self.client.get("/api/export").get_data(as_text=True))
        with self.db() as db:
            db.execute("DELETE FROM tasks")
        imported = self.client.post("/api/import", json={"data": exported}, headers={"X-CSRF-Token": self.csrf()})
        self.assertEqual(imported.status_code, 200, imported.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
