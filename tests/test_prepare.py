"""Project-provided scenario preparation runs first and blocks, never fails as business."""
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))
from cli import dispatch  # noqa: E402


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="playtest-prepare-")
        self.root = Path(self.temp.name).resolve()
        (self.root / ".test-plays" / "demo").mkdir(parents=True)
        # Preparation is read-only, so the repository database must already exist:
        # pointing it at ${runDir} would let a readiness check create a file.
        import sqlite3
        sqlite3.connect(self.root / "fixture.sqlite").execute("CREATE TABLE ready (ok INTEGER)").connection.commit()
        self.write(self.root / ".test-plays/config.json", {
            "targets": {"local": {"baseUrl": "http://127.0.0.1:1"}},
            "databases": {"main": {"driver": "sqlite", "path": "fixture.sqlite"}},
        })

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, value):
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def assets(self, prepare, steps=None, scenario=None):
        config = json.loads((self.root / ".test-plays/config.json").read_text())
        config["prepare"] = prepare
        self.write(self.root / ".test-plays/config.json", config)
        self.write(self.root / ".test-plays" / "demo" / "play.json", {
            "version": 1, "scenarioName": "demo", "mode": "baseline",
            "steps": steps if steps is not None else [
                {"stepNo": 1, "name": "业务步骤", "type": "dbQuery", "database": "main",
                 "sql": "SELECT COUNT(*) AS ok FROM ready", "expect": {"ok": 0}}]})
        self.write(self.root / ".test-plays" / "demo" / "scenario.json", scenario if scenario is not None else {
            "setup": [{"stepNo": 1, "type": "dbQuery", "database": "main",
                       "sql": "SELECT 2 AS n", "expect": {"n": 2}}],
            "cleanup": [], "mocks": []})

    def run_play(self):
        output = io.StringIO()
        result = dispatch({"action": "run", "repoRoot": str(self.root), "play": "demo",
                           "allowEffects": True}, output)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        return result, events

    def inspect(self):
        return dispatch({"action": "inspect", "repoRoot": str(self.root), "play": "demo"})

    def test_ready_environment_runs_prepare_then_setup_then_play(self):
        self.assets([{"stepNo": 1, "name": "数据库可访问", "type": "dbQuery", "database": "main",
                      "readOnly": True, "sql": "SELECT COUNT(*) AS ok FROM ready", "expect": {"ok": 0}}])
        result, events = self.run_play()
        self.assertEqual([s["phase"] for s in result["steps"]], ["prepare", "setup", "play"])
        self.assertEqual([e["phase"] for e in events if e["type"] == "phase_started"],
                         ["prepare", "setup", "play", "cleanup"])
        self.assertEqual(result["execution"], "completed")
        self.assertEqual(result["verdict"], "passed")

    def test_unready_environment_blocks_without_running_setup_or_play(self):
        self.assets([{"stepNo": 1, "name": "服务在线", "type": "dbQuery", "database": "main",
                      "readOnly": True, "sql": "SELECT COUNT(*) AS ok FROM ready", "expect": {"ok": 9}}])
        result, events = self.run_play()
        self.assertEqual(result["execution"], "blocked")
        self.assertEqual(result["verdict"], "inconclusive")
        self.assertEqual(result["cleanup"], "skipped")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["exitCode"], 2, "environment problem, not a test failure")
        self.assertEqual([step["phase"] for step in result["steps"]], ["prepare"],
                         "setup and play must not run against an unready environment")
        skipped = [e for e in events if e["type"] == "phase_finished" and e.get("status") == "skipped"]
        self.assertTrue(any("场景准备未通过" in json.dumps(e, ensure_ascii=False) for e in skipped), skipped)

    def test_preparing_step_error_is_blocked_not_business_failed(self):
        self.assets([{"stepNo": 1, "name": "坏查询", "type": "dbQuery", "database": "main",
                      "readOnly": True, "sql": "SELECT * FROM missing", "expect": {"ok": 1}}])
        result, _ = self.run_play()
        self.assertEqual(result["execution"], "blocked")
        self.assertEqual(result["steps"][0]["status"], "failed")
        self.assertEqual(result["steps"][0]["errorCode"], "database")

    def test_mutation_and_weak_checks_are_rejected_before_running(self):
        cases = [
            ([{"stepNo": 1, "type": "dbQuery", "database": "main", "sql": "UPDATE t SET a=1"}], "prepare_readonly"),
            ([{"stepNo": 1, "type": "dbQuery", "database": "main", "readOnly": True, "sql": "SELECT 1"}], "prepare_expect"),
            ([{"stepNo": 1, "type": "http", "target": "local", "method": "POST", "path": "/x",
               "expect": {"status": 200}}], "prepare_method"),
            ([{"stepNo": 1, "type": "wait", "seconds": 1, "expect": {}}], "prepare_type"),
            ([{"stepNo": 1, "type": "http", "path": "/x", "expect": {"status": 200}}], "prepare_target"),
        ]
        for prepare, code in cases:
            with self.subTest(code=code):
                self.assets(prepare)
                issues = self.inspect()["issues"]
                self.assertTrue(any(i["code"] == code for i in issues), (code, issues))
                self.assertFalse(self.inspect()["ok"])

    def test_prepare_target_resolves_to_the_declared_service(self):
        self.assets([{"stepNo": 1, "name": "健康检查", "type": "http", "target": "local",
                      "path": "/health", "expect": {"status": 200}}])
        inspection = self.inspect()
        self.assertTrue(inspection["ok"], inspection["issues"])
        self.assertEqual(inspection["preview"]["prepare"][0]["target"], "local")
        result, _ = self.run_play()
        self.assertEqual(result["execution"], "blocked", "connection refused must not look like a test pass")
        self.assertEqual(result["steps"][0]["errorCode"], "transport")

    def test_prepare_effects_require_confirmation_like_every_real_call(self):
        self.assets([{"stepNo": 1, "name": "健康检查", "type": "http", "target": "local",
                      "path": "/health", "expect": {"status": 200}}])
        inspection = self.inspect()
        prepare_effects = [e for e in inspection["effects"] if e["phase"] == "prepare"]
        self.assertEqual(len(prepare_effects), 1)
        self.assertTrue(prepare_effects[0]["requiresConfirmation"])
        self.assertEqual(prepare_effects[0]["play"], "demo",
                         "each play must prove its own preparation before running")

    def test_readiness_checks_never_mask_a_missing_business_assertion(self):
        # The repository declares readiness; that must not make an assertion-free
        # play look verified.
        self.assets([{"stepNo": 1, "name": "库可访问", "type": "dbQuery", "database": "main",
                      "readOnly": True, "sql": "SELECT COUNT(*) AS ok FROM ready", "expect": {"ok": 0}}],
                    steps=[{"stepNo": 1, "name": "只观察", "type": "dbQuery", "database": "main",
                            "readOnly": True, "sql": "SELECT COUNT(*) AS ok FROM ready"}],
                    scenario={"setup": [], "cleanup": [], "mocks": []})
        inspection = self.inspect()
        issues = [(i["level"], i["code"]) for i in inspection["issues"]]
        self.assertIn(("warning", "no_assertions"), issues, issues)
        self.assertEqual(inspection["preview"]["assertions"], 0)
        self.assertEqual(inspection["preview"]["prepareAssertions"], 1)

    def test_no_prepare_keeps_previous_behaviour(self):
        self.assets([])
        result, _ = self.run_play()
        self.assertEqual([s["phase"] for s in result["steps"]], ["setup", "play"])
        self.assertEqual(result["execution"], "completed")


if __name__ == "__main__":
    unittest.main()
