"""Regression tests use temporary repositories and local mock servers only."""
import io
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))
from cli import dispatch
from common import EngineError, compile_request, substitute


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="playtest-engine-")
        self.root = Path(self.temp.name).resolve()
        self.directory = self.root / "test-plays" / "demo"
        self.directory.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def write_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def assets(self, steps, scenario=None, extra=None):
        self.write_json(self.directory / "play.json", {
            "version": 1, "scenarioName": "demo", "mode": "baseline",
            "steps": steps, **(extra or {})})
        self.write_json(self.directory / "scenario.json", scenario or {"setup": [], "cleanup": [], "mocks": []})

    def mocks(self, routes=None):
        return {"mocks": [{"id": "api", "port": 0, "routes": routes or [
            {"method": "GET", "path": "/ok", "status": 200, "body": {"ok": True, "n": 7}}
        ]}]}

    def http_step(self, **updates):
        return {"stepNo": 1, "name": "Request", "type": "http", "method": "GET",
                "path": "${mock.api.url}/ok", "expect": {"status": 200, "json": {"$.ok": True}}, **updates}

    def command(self, action, **updates):
        return {"action": action, "repoRoot": str(self.root), "play": "demo", **updates}

    def run_play(self, **updates):
        output = io.StringIO()
        result = dispatch(self.command("run", **updates), output)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[-1]["type"], "run_finished")
        self.assertEqual(events[-1]["result"], result)
        self.assertEqual([event["seq"] for event in events], list(range(1, len(events) + 1)))
        return result, events

    def sqlite_config(self, path="${runDir}/db.sqlite"):
        self.write_json(self.root / ".playtest.json", {"databases": {"main": {"driver": "sqlite", "path": path}}})

    def test_scaffold_catalog_inspect_and_run(self):
        result = dispatch({"action": "scaffold", "repoRoot": str(self.root), "name": "new-demo"})
        self.assertTrue(result["ok"])
        self.assertEqual(dispatch({"action": "catalog", "repoRoot": str(self.root)})["plays"][0]["slug"], "new-demo")
        inspection = dispatch(self.command("inspect", play="new-demo"))
        self.assertFalse(inspection["requiresConfirmation"])
        self.assertEqual(inspection["preview"]["assertions"], 4)
        result, events = self.run_play(play="new-demo", expectedDigest=inspection["digest"], ownerSessionId="session-demo")
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["ownerSessionId"], "session-demo")
        self.assertTrue(any(event["type"] == "mock_request" for event in events))

    def test_wrong_json_assertion_fails(self):
        self.assets([self.http_step(expect={"status": 200, "json": {"$.n": 99}})], self.mocks())
        result, _ = self.run_play()
        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "failed")
        self.assertEqual(result["exitCode"], 1)
        self.assertFalse(result["assertions"][1]["ok"])

    def test_http_error_is_not_false_success(self):
        self.assets([self.http_step(expect={"json": {"$.ok": True}})], self.mocks([
            {"method": "GET", "path": "/ok", "status": 500, "body": {"ok": True}}
        ]))
        result, _ = self.run_play()
        self.assertFalse(result["ok"])
        self.assertEqual(result["steps"][0]["errorCode"], "http_status")

    def test_explicit_http_refusal_assertions_pass(self):
        self.assets([self.http_step(expect={"status": 409, "json": {"$.code": "duplicate"}})], self.mocks([
            {"method": "GET", "path": "/ok", "status": 409, "body": {"code": "duplicate"}}
        ]))
        result, _ = self.run_play()
        self.assertEqual(result["verdict"], "passed")

    def test_legacy_expect_failure_is_rejected(self):
        self.assets([self.http_step(expectFailure=True)], self.mocks())
        result = dispatch(self.command("lint"))
        self.assertFalse(result["ok"])
        self.assertTrue(any(i["code"] == "legacy_expect_failure" for i in result["issues"]))

    def test_typed_variables_and_response_extraction(self):
        scenario = self.mocks([
            {"method": "GET", "path": "/ok", "status": 200, "body": {"n": 7, "items": [1, 2], "yes": True, "nothing": None}},
            {"method": "POST", "path": "/typed", "status": 200, "body": {"ok": True}}
        ])
        self.assets([
            self.http_step(expect={"status": 200}, extractFromResponse={"n": "$.n", "items": "$.items", "yes": "$.yes", "nothing": "$.nothing"}),
            {"stepNo": 2, "type": "http", "method": "POST", "path": "${mock.api.url}/typed",
             "body": {"n": "${n}", "items": "${items}", "yes": "${yes}", "nothing": "${nothing}", "text": "n=${n}"}, "expect": {"status": 200}}
        ], scenario)
        result, _ = self.run_play()
        self.assertTrue(result["ok"])
        body = result["steps"][1]["evidence"]["data"]["request"]["body"]
        self.assertEqual(body, {"n": 7, "items": [1, 2], "yes": True, "nothing": None, "text": "n=7"})
        self.assertIsInstance(body["n"], int)
        self.assertIs(body["yes"], True)
        with self.assertRaises(EngineError):
            substitute("${missing}", {})

    def test_missing_variable_fails_before_request(self):
        self.assets([self.http_step(headers={"X-Value": "${unknown}"})], self.mocks())
        result, events = self.run_play()
        self.assertFalse(result["ok"])
        self.assertEqual(result["steps"][0]["errorCode"], "missing_variable")
        self.assertFalse(any(event["type"] == "mock_request" for event in events))

    def test_no_assertions_is_inconclusive(self):
        self.assets([{"stepNo": 1, "type": "wait", "seconds": 0}])
        result, _ = self.run_play()
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "inconclusive")
        self.assertEqual(result["steps"][0]["status"], "observed")

    def test_sqlite_queries_parameters_and_assertions(self):
        self.sqlite_config()
        self.assets([
            {"stepNo": 1, "type": "dbQuery", "sql": "SELECT n, enabled FROM sample", "expect": {"n": 7, "enabled": 1}, "extract": {"n": "n"}},
            {"stepNo": 2, "type": "dbQuery", "sql": "SELECT ? AS n", "params": ["${n}"], "expect": {"n": 7}},
            {"stepNo": 3, "type": "dbWait", "sql": "SELECT n FROM sample", "expect": {"n": 7}, "timeoutSeconds": 0.1}
        ], {"setup": [
            {"stepNo": 1, "type": "dbQuery", "sql": "CREATE TABLE sample(n INTEGER, enabled INTEGER)"},
            {"stepNo": 2, "type": "dbQuery", "sql": "INSERT INTO sample VALUES (?, ?)", "params": [7, 1]}
        ], "cleanup": [{"stepNo": 1, "type": "dbQuery", "sql": "DELETE FROM sample"}]})
        inspection = dispatch(self.command("inspect"))
        self.assertFalse(inspection["requiresConfirmation"])
        result, _ = self.run_play()
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["cleanup"], "completed")

    def test_sqlite_wrong_expectation_fails(self):
        database = self.root / "shared.sqlite"
        conn = sqlite3.connect(database)
        conn.execute("CREATE TABLE sample(n)")
        conn.execute("INSERT INTO sample VALUES (7)")
        conn.commit()
        conn.close()
        self.sqlite_config("shared.sqlite")
        self.assets([{"stepNo": 1, "type": "dbQuery", "sql": "SELECT n FROM sample", "expect": {"n": 8}}])
        result, _ = self.run_play()
        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "failed")

    def test_setup_failure_still_cleans_up(self):
        self.sqlite_config()
        self.assets([{"stepNo": 1, "type": "wait", "seconds": 0}], {
            "setup": [{"stepNo": 1, "type": "dbQuery", "sql": "CREATE TABLE sample(value TEXT)"},
                      {"stepNo": 2, "type": "dbQuery", "sql": "invalid SQL"}],
            "cleanup": [{"stepNo": 1, "type": "dbQuery", "sql": "INSERT INTO sample VALUES ('cleaned')"}]})
        result, events = self.run_play(runId="setup-failure")
        self.assertFalse(result["ok"])
        self.assertEqual(result["cleanup"], "completed")
        conn = sqlite3.connect(self.root / ".playtest/runs/setup-failure/db.sqlite")
        self.assertEqual(conn.execute("SELECT value FROM sample").fetchone()[0], "cleaned")
        conn.close()
        self.assertFalse(any(e["type"] == "step_started" and e.get("phase") == "play" for e in events))

    def test_cancellation_runs_cleanup_not_next_step(self):
        self.sqlite_config()
        self.assets([
            {"stepNo": 1, "type": "wait", "seconds": 30},
            {"stepNo": 2, "type": "dbQuery", "sql": "INSERT INTO sample VALUES ('should-not-run')"}
        ], {"setup": [{"stepNo": 1, "type": "dbQuery", "sql": "CREATE TABLE sample(value TEXT)"}],
            "cleanup": [{"stepNo": 1, "type": "dbQuery", "sql": "INSERT INTO sample VALUES ('cleaned')"}]})
        process = subprocess.Popen([sys.executable, str(ENGINE / "cli.py")], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        process.stdin.write(json.dumps(self.command("run", runId="cancel-test")))
        process.stdin.close()
        process.stdin = None
        first_events = []
        try:
            for line in process.stdout:
                event = json.loads(line)
                first_events.append(event)
                if event["type"] == "step_started" and event.get("phase") == "play":
                    process.send_signal(signal.SIGTERM)
                    break
            rest, stderr = process.communicate(timeout=15)
        except BaseException:
            process.kill()
            process.communicate()
            raise
        self.assertEqual(process.returncode, 130, stderr)
        events = first_events + [json.loads(line) for line in rest.splitlines()]
        result = events[-1]["result"]
        self.assertEqual(result["execution"], "cancelled")
        self.assertEqual(result["cleanup"], "completed")
        conn = sqlite3.connect(self.root / ".playtest/runs/cancel-test/db.sqlite")
        self.assertEqual(conn.execute("SELECT value FROM sample").fetchall(), [("cleaned",)])
        conn.close()

    def test_mock_request_counts_match_and_fail(self):
        self.assets([
            self.http_step(), self.http_step(stepNo=2),
            {"stepNo": 3, "type": "mockVerify", "mock": "api", "path": "/ok", "method": "GET", "count": 2}
        ], self.mocks())
        result, _ = self.run_play()
        self.assertEqual(result["verdict"], "passed")
        play = json.loads((self.directory / "play.json").read_text())
        play["steps"][2]["count"] = 3
        self.write_json(self.directory / "play.json", play)
        result, _ = self.run_play()
        self.assertFalse(result["ok"])
        self.assertEqual(result["assertions"][-1]["actual"]["data"], 2)

    def test_assets_not_overwritten_and_stale_digest_rejected(self):
        self.assets([self.http_step()], self.mocks())
        original = (self.directory / "play.json").read_bytes()
        inspection = dispatch(self.command("inspect"))
        result, _ = self.run_play(expectedDigest=inspection["digest"])
        self.assertEqual((self.directory / "play.json").read_bytes(), original)
        self.assertTrue(Path(result["artifacts"]["snapshot"]).is_file())
        self.assertTrue(Path(result["artifacts"]["events"]).is_file())
        self.assertTrue(Path(result["artifacts"]["result"]).is_file())
        self.assets([self.http_step(expect={"status": 201})], self.mocks())
        with self.assertRaisesRegex(EngineError, "changed since inspect"):
            dispatch(self.command("run", expectedDigest=inspection["digest"], runId="stale"))
        self.assertFalse((self.root / ".playtest/runs/stale").exists())

    def test_referenced_sql_file_is_snapshotted_and_digest_checked(self):
        self.sqlite_config()
        (self.directory / "create.sql").write_text("CREATE TABLE sample(n)")
        self.assets([{"stepNo": 1, "type": "dbQuery", "sql": "SELECT COUNT(*) AS n FROM sample", "expect": {"n": 0}}],
                    {"setup": [{"stepNo": 1, "type": "dbQuery", "sqlFile": "create.sql"}]})
        inspected = dispatch(self.command("inspect"))
        self.assertIn("test-plays/demo/create.sql", inspected["snapshot"]["assets"])
        (self.directory / "create.sql").write_text("CREATE TABLE sample(n, other)")
        with self.assertRaises(EngineError):
            dispatch(self.command("run", expectedDigest=inspected["digest"]))

    def test_path_traversal_and_symlink_escape_rejected(self):
        self.assets([{"stepNo": 1, "type": "wait", "seconds": 0}])
        with self.assertRaises(EngineError):
            dispatch(self.command("inspect", play="../outside.json"))
        with tempfile.TemporaryDirectory() as outside:
            escape = self.root / "outside"
            escape.symlink_to(outside, target_is_directory=True)
            self.sqlite_config("outside/db.sqlite")
            self.assertFalse(dispatch(self.command("lint"))["ok"])
        self.sqlite_config()
        with self.assertRaises(EngineError):
            dispatch(self.command("run", runId="../escape"))

    def test_http_origin_and_redirect_restrictions(self):
        class Handler(BaseHTTPRequestHandler):
            calls = 0
            def do_GET(self):
                Handler.calls += 1
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:1/forbidden")
                self.end_headers()
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = "http://127.0.0.1:" + str(server.server_port)
        try:
            self.assets([{"stepNo": 1, "type": "http", "path": "/redirect", "expect": {"status": 200}}], extra={"baseUrl": base_url})
            with self.assertRaisesRegex(EngineError, "confirmation"):
                dispatch(self.command("run"))
            self.assertEqual(Handler.calls, 0)
            result, _ = self.run_play(allowEffects=True)
            self.assertFalse(result["ok"])
            self.assertEqual(result["steps"][0]["errorCode"], "origin_restriction")
            self.assets([{"stepNo": 1, "type": "http", "path": "http://127.0.0.1:1/outside", "expect": {"status": 200}}], extra={"baseUrl": base_url})
            result, _ = self.run_play(allowEffects=True)
            self.assertEqual(result["steps"][0]["errorCode"], "origin_restriction")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_non_run_database_write_requires_confirmation(self):
        self.sqlite_config("shared.sqlite")
        self.assets([{"stepNo": 1, "type": "dbQuery", "sql": "CREATE TABLE sample(n)"}])
        self.assertTrue(dispatch(self.command("inspect"))["requiresConfirmation"])
        with self.assertRaises(EngineError):
            dispatch(self.command("run"))
        self.assertFalse((self.root / "shared.sqlite").exists())

    def test_sqlite_attach_cannot_escape_scope(self):
        self.sqlite_config()
        self.assets([{"stepNo": 1, "type": "dbQuery", "sql": "ATTACH DATABASE ? AS outside", "params": [str(self.root.parent / "forbidden.sqlite")]}])
        result, _ = self.run_play()
        self.assertFalse(result["ok"])
        self.assertIn("not authorized", result["steps"][0]["error"])

    def test_read_only_does_not_create_database(self):
        self.sqlite_config("missing.sqlite")
        self.assets([{"stepNo": 1, "type": "dbQuery", "sql": "SELECT 1 AS n", "expect": {"n": 1}}])
        result, _ = self.run_play()
        self.assertFalse(result["ok"])
        self.assertFalse((self.root / "missing.sqlite").exists())

    def test_redaction_and_bounded_evidence(self):
        scenario = self.mocks([{ "method": "GET", "path": "/ok", "status": 200,
            "body": {"token": "TOPSECRET", "large": "x" * 10000}}])
        self.assets([self.http_step(headers={"Authorization": "Bearer TOPSECRET"},
                                    expect={"status": 200, "json": {"$.token": "TOPSECRET"}})], scenario)
        result, events = self.run_play()
        self.assertTrue(result["ok"])
        self.assertTrue(result["steps"][0]["evidence"]["truncated"])
        for path in result["artifacts"].values():
            self.assertNotIn("TOPSECRET", Path(path).read_text())
        self.assertNotIn("TOPSECRET", json.dumps(events))
        inspected = dispatch(self.command("inspect"))
        self.assertNotIn("TOPSECRET", json.dumps(inspected))

    def test_unknown_selection_and_empty_lint_are_not_green(self):
        self.assertFalse(dispatch({"action": "lint", "repoRoot": str(self.root)})["ok"])
        self.assertFalse(dispatch(self.command("lint", play="unknown"))["ok"])
        with self.assertRaises(EngineError):
            dispatch({"action": "scaffold", "repoRoot": str(self.root), "name": "../outside"})

    def test_multiple_plays_have_distinct_phases_and_one_run(self):
        self.assets([self.http_step()], self.mocks())
        second = self.root / "test-plays" / "second"
        self.write_json(second / "play.json", {"version": 1, "scenarioName": "second", "steps": [self.http_step()]})
        self.write_json(second / "scenario.json", self.mocks())
        result, _ = self.run_play(play=None, plays=["demo", "second"])
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["subRuns"]), 2)
        self.assertEqual({s["play"] for s in result["steps"]}, {"demo", "second"})


    def test_http_status_placeholder_is_typed_and_runtime_validated(self):
        scenario = self.mocks()
        scenario["variables"] = {"status": 200}
        self.assets([self.http_step(expect={"status": "${status}"})], scenario)
        self.assertTrue(dispatch(self.command("lint"))["ok"])
        result, _ = self.run_play()
        self.assertEqual(result["verdict"], "passed")
        scenario["variables"]["status"] = "200"
        self.write_json(self.directory / "scenario.json", scenario)
        result, events = self.run_play()
        self.assertFalse(result["ok"])
        self.assertEqual(result["steps"][0]["errorCode"], "invalid_step")
        self.assertFalse(any(e["type"] == "mock_request" for e in events))
        self.assets([self.http_step(expect={"status": "arbitrary"})], self.mocks())
        self.assertFalse(dispatch(self.command("lint"))["ok"])

    def test_setup_assertions_do_not_make_business_play_pass(self):
        self.sqlite_config()
        self.assets([{"stepNo": 1, "type": "wait", "seconds": 0}], {
            "setup": [{"stepNo": 1, "type": "dbQuery", "sql": "CREATE TABLE sample(n)"},
                      {"stepNo": 2, "type": "dbQuery", "sql": "SELECT 1 AS n", "expect": {"n": 1}}]})
        result, _ = self.run_play()
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "inconclusive")
        self.assertTrue(result["assertions"])

    def test_failed_setup_assertion_is_execution_failure_not_business_failure(self):
        self.sqlite_config()
        self.assets([{"stepNo": 1, "type": "wait", "seconds": 0}], {
            "setup": [{"stepNo": 1, "type": "dbQuery", "sql": "CREATE TABLE sample(n)"},
                      {"stepNo": 2, "type": "dbQuery", "sql": "SELECT 1 AS n", "expect": {"n": 2}}],
            "cleanup": [{"stepNo": 1, "type": "dbQuery", "sql": "DROP TABLE sample"}]})
        result, _ = self.run_play()
        self.assertFalse(result["ok"])
        self.assertEqual(result["execution"], "failed")
        self.assertEqual(result["verdict"], "inconclusive")
        self.assertEqual(result["cleanup"], "completed")

    def test_cleanup_assertion_failure_does_not_rewrite_business_verdict(self):
        self.assets([self.http_step()], {**self.mocks(), "cleanup": [self.http_step(expect={"status": 201})]})
        result, _ = self.run_play()
        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["cleanup"], "failed")
        self.assertEqual(result["exitCode"], 1)

    def test_parent_demo_examples_are_local_and_have_expected_verdicts(self):
        import shutil
        demo_root = Path(__file__).resolve().parents[1] / "examples" / "demo-project"
        if not demo_root.is_dir():
            self.skipTest("Parent demo examples are not present")
        shutil.copytree(demo_root, self.root, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(".playtest", "__pycache__"))
        cases = [
            ("payment-response", "scenario.json", "passed"),
            ("payment-response", "scenario-approved.json", "passed"),
            ("stock-reservation", "scenario.json", "passed"),
            ("stock-reservation", "scenario-assertion-fails.json", "failed"),
        ]
        for play, scenario, expected in cases:
            with self.subTest(play=play, scenario=scenario):
                inspected = dispatch(self.command("inspect", play=play, scenario=scenario))
                self.assertTrue(inspected["ok"], inspected["issues"])
                self.assertFalse(inspected["requiresConfirmation"])
                result, _ = self.run_play(play=play, scenario=scenario, expectedDigest=inspected["digest"])
                self.assertEqual(result["verdict"], expected)
                self.assertEqual(result["ok"], expected == "passed")
                self.assertEqual(result["cleanup"], "completed")


    def test_play_and_scenario_cleanup_both_execute(self):
        self.assets([self.http_step()], {**self.mocks(), "cleanup": [self.http_step()]},
                    extra={"cleanup": [self.http_step()]})
        result, _ = self.run_play()
        self.assertTrue(result["ok"])
        cleanup = [step for step in result["steps"] if step["phase"] == "cleanup"]
        self.assertEqual([step["stepNo"] for step in cleanup], [1, 2])

    def test_cli_outer_runner_failure_reports_unknown_cleanup(self):
        from unittest.mock import patch
        from cli import main
        self.assets([self.http_step()], self.mocks())
        output = io.StringIO()
        with patch("sys.stdin", io.StringIO(json.dumps(self.command("run")))), patch("sys.stdout", output), patch("cli.run", side_effect=OSError("artifact write failed")):
            code = main()
        event = json.loads(output.getvalue())
        self.assertEqual(code, 2)
        self.assertEqual(event["type"], "run_finished")
        self.assertEqual(event["result"]["cleanup"], "unknown")


if __name__ == "__main__":
    unittest.main()
