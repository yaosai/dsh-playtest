"""Embedded verification: a step's checks decide its own status, not a new step."""
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))
from cli import dispatch  # noqa: E402


class EmbeddedCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="playtest-checks-")
        self.root = Path(self.temp.name).resolve()
        self.directory = self.root / ".test-plays" / "demo"
        self.directory.mkdir(parents=True)
        self.write_json(self.root / ".test-plays/config.json",
                        {"databases": {"main": {"driver": "sqlite", "path": "${runDir}/db.sqlite"}}})

    def tearDown(self):
        self.temp.cleanup()

    def write_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def assets(self, steps, mocks=None):
        self.write_json(self.directory / "play.json",
                        {"version": 1, "scenarioName": "demo", "mode": "baseline", "steps": steps})
        self.write_json(self.directory / "scenario.json", {
            "setup": [{"stepNo": 1, "type": "dbQuery", "database": "main",
                       "sql": "CREATE TABLE IF NOT EXISTS t(n INTEGER)"}],
            "cleanup": [],
            "mocks": (mocks or {}).get("mocks", [])})

    def api(self):
        return {"mocks": [{"id": "api", "port": 0, "routes": [
            {"method": "POST", "path": "/go", "status": 200, "body": {"ok": True}}]}]}

    def run_play(self):
        output = io.StringIO()
        result = dispatch({"action": "run", "repoRoot": str(self.root), "play": "demo"}, output)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[-1]["type"], "run_finished")
        return result, events

    @staticmethod
    def play_steps(result):
        return [s for s in result["steps"] if s["phase"] == "play"]

    def inspect(self):
        return dispatch({"action": "inspect", "repoRoot": str(self.root), "play": "demo"})

    def test_passing_check_makes_the_action_step_pass_without_extra_steps(self):
        self.assets([
            {"stepNo": 1, "name": "写入", "type": "http", "method": "POST",
             "path": "${mock.api.url}/go", "expect": {"status": 200},
             "checks": [{"name": "行已存在", "type": "dbQuery", "database": "main", "readOnly": True,
                         "sql": "SELECT COUNT(*) AS c FROM t", "expect": {"c": 0}}]}
        ], self.api())
        result, _ = self.run_play()
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(len(self.play_steps(result)), 1, "checks must not become steps")
        step = self.play_steps(result)[0]
        self.assertEqual(step["status"], "passed")
        self.assertEqual(step["assertionCount"], 2, "action and check assertions both count")
        self.assertEqual([c["status"] for c in step["checks"]], ["passed"])
        self.assertEqual(self.inspect()["preview"]["plays"][0]["steps"][0]["checks"][0]["name"], "行已存在")

    def test_failed_check_fails_the_action_step_and_stops_the_run(self):
        self.assets([
            {"stepNo": 1, "name": "写入", "type": "http", "method": "POST",
             "path": "${mock.api.url}/go", "expect": {"status": 200},
             "checks": [{"name": "应有一行", "type": "dbQuery", "database": "main", "readOnly": True,
                         "sql": "SELECT COUNT(*) AS c FROM t", "expect": {"c": 1}}]},
            {"stepNo": 2, "name": "不应执行", "type": "wait", "seconds": 0}
        ], self.api())
        result, _ = self.run_play()
        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "failed")
        self.assertEqual(result["execution"], "completed")
        self.assertEqual([s["stepNo"] for s in self.play_steps(result)], [1], "later steps must not run")
        step = self.play_steps(result)[0]
        self.assertEqual(step["status"], "failed")
        self.assertEqual(step["checks"][0]["status"], "failed")
        failed = [a for a in result["assertions"] if a["phase"] == "play" and not a["ok"]]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["stepId"], step["id"], "the check assertion belongs to the action step")

    def test_check_error_is_distinguishable_from_a_failed_expectation(self):
        self.assets([
            {"stepNo": 1, "name": "写入", "type": "http", "method": "POST",
             "path": "${mock.api.url}/go", "expect": {"status": 200},
             "checks": [{"name": "坏查询", "type": "dbQuery", "database": "main", "readOnly": True,
                         "sql": "SELECT * FROM missing_table", "expect": {"x": 1}}]}
        ], self.api())
        result, _ = self.run_play()
        step = self.play_steps(result)[0]
        self.assertEqual(step["status"], "failed")
        self.assertEqual(step["checks"][0]["status"], "error")
        self.assertEqual(step.get("errorCode"), "database")
        self.assertNotIn("Explicit assertion mismatch", step.get("error", ""))

    def test_action_without_assertions_stays_observed_even_with_passing_check(self):
        self.assets([
            {"stepNo": 1, "name": "只等待", "type": "wait", "seconds": 0}
        ], self.api())
        result, _ = self.run_play()
        self.assertEqual(self.play_steps(result)[0]["status"], "observed")
        self.assertEqual(result["verdict"], "inconclusive")

    def test_nested_checks_and_action_checks_are_rejected(self):
        self.assets([
            {"stepNo": 1, "name": "嵌套", "type": "wait", "seconds": 0,
             "checks": [{"name": "a", "type": "dbQuery", "database": "main",
                         "sql": "SELECT 1", "checks": [{"type": "dbQuery", "sql": "SELECT 1"}]}]}
        ], self.api())
        issues = self.inspect()["issues"]
        self.assertTrue(any(i["code"] == "checks_nested" for i in issues), issues)

        self.assets([
            {"stepNo": 1, "name": "动作当校验", "type": "wait", "seconds": 0,
             "checks": [{"name": "http", "type": "http", "path": "/x"}]}
        ], self.api())
        issues = self.inspect()["issues"]
        self.assertTrue(any(i["code"] == "check_type" for i in issues), issues)

    def test_empty_checks_array_is_rejected(self):
        self.assets([{"stepNo": 1, "name": "空", "type": "wait", "seconds": 0, "checks": []}], self.api())
        issues = self.inspect()["issues"]
        self.assertTrue(any(i["code"] == "checks" for i in issues), issues)

    def test_check_can_extract_for_later_steps(self):
        self.assets([
            {"stepNo": 1, "name": "写入", "type": "http", "method": "POST",
             "path": "${mock.api.url}/go", "expect": {"status": 200},
             "checks": [{"name": "取数", "type": "dbQuery", "database": "main", "readOnly": True,
                         "sql": "SELECT 7 AS n", "extract": {"seven": "n"}}]},
            {"stepNo": 2, "name": "使用", "type": "dbQuery", "database": "main", "readOnly": True,
             "sql": "SELECT ? AS n", "params": ["${seven}"], "expect": {"n": 7}}
        ], self.api())
        result, _ = self.run_play()
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(sum(1 for s in self.play_steps(result) if s["stepNo"] == 1), 1)


if __name__ == "__main__":
    unittest.main()