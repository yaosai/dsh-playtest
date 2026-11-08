"""Command DB regression tests: trusted fake scripts in temporary repositories.

No real database, HTTP request, decryption, or business adapter is executed.
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))
from cli import dispatch
from common import EngineError, compile_request
from player import Runner

TARGET = {"host": "127.0.0.1", "port": 1433, "database": "FAKE_ONLY"}
FAKE = r'''
import json, os, pathlib, signal, subprocess, sys, time
p = json.load(sys.stdin)
r = pathlib.Path(p["runDir"])
child = None
def cooperative_stop(_s, _f):
    if child is not None:
        try:
            child.terminate()
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os._exit(143)
signal.signal(signal.SIGTERM, cooperative_stop)
signal.signal(signal.SIGINT, cooperative_stop)
with (r / "requests.jsonl").open("a", encoding="utf-8") as f:
    f.write(json.dumps(p) + "\n")
sql = p["sql"]
reply = {"ok": True, "rows": [{"value": p["params"][0] if p["params"] else 7,
                                "readOnly": p["readOnly"], "allowWrite": p["allowWrite"],
                                "params": p["params"]}],
         "rowsAffected": 0, "target": p["expectedTarget"]}
if sql == "EMPTY":
    sys.exit(0)
if sql == "INVALID":
    print("not-json")
    sys.exit(0)
if sql == "TABLE":
    print("| value |\n| 7 |")
    sys.exit(0)
if sql == "ERROR":
    reply = {"ok": False, "error": "password=do-not-leak database refused", "code": "database"}
if sql == "BAD_ROWS":
    reply["rows"] = [7]
if sql == "NO_ROWS":
    reply["rows"] = []
if sql == "TOO_MANY_ROWS":
    reply["rows"] = [{"value": 7} for _ in range(1001)]
if sql == "BAD_AFFECTED":
    reply["rowsAffected"] = True
if sql == "BAD_OK":
    reply["ok"] = "true"
if sql == "WRONG_TARGET":
    reply["target"] = {**p["expectedTarget"], "database": "WRONG"}
if sql == "BAD_TARGET_TYPE":
    reply["target"] = {**p["expectedTarget"], "port": float(p["expectedTarget"]["port"])}
if sql == "DUPLICATE_JSON":
    print('{"ok":true,"ok":true,"rows":[],"rowsAffected":0,"target":{}}')
    sys.exit(0)
if sql == "NAN":
    print('{"ok":true,"rows":[{"value":NaN}],"rowsAffected":0,"target":{}}')
    sys.exit(0)
if sql == "STDERR":
    os.write(2, b"x" * 5000 + b"tail")
if sql in ("SLEEP", "OVERFLOW"):
    child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
    (r / "child-ready").write_text(str(child.pid))
if sql == "OVERFLOW":
    while True:
        os.write(1, b"x" * 65536)
if sql == "SLEEP":
    time.sleep(30)
if sql == "IGNORE_TERM":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(30)
if sql == "UNHANDLED_TERM":
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    time.sleep(30)
if sql == "CANCEL":
    marker = str(r / "late-child-write")
    child = subprocess.Popen([sys.executable, "-c", "import pathlib,sys,time;time.sleep(3);pathlib.Path(sys.argv[1]).write_text('unsafe')", marker])
    def stop(_s, _f):
        try:
            child.terminate()
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        os._exit(143)
    signal.signal(signal.SIGTERM, stop)
    (r / "child-ready").write_text(str(child.pid))
    time.sleep(30)
print(json.dumps(reply))
sys.exit(3 if sql == "NONZERO" else 0)
'''


@unittest.skipUnless(os.name == "posix", "Selector pipe collection currently requires POSIX")
class CommandDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="playtest-command-db-")
        self.root = Path(self.temp.name).resolve()
        self.directory = self.root / "test-plays" / "demo"
        self.directory.mkdir(parents=True)
        tools = self.root / "tools"
        tools.mkdir()
        self.adapter = tools / "fake.py"
        self.adapter.write_text(FAKE, encoding="utf-8")
        self.private = tools / "private.conf"
        self.private.write_text("UNRELATED_PRIVATE_CONTENT_MUST_NOT_APPEAR", encoding="utf-8")
        self.env_patch = patch.dict(os.environ, {"PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
                                                 "PYTHONDONTWRITEBYTECODE": "1"})
        self.env_patch.start()
        self.config = {"databases": {"main": {"driver": "command",
                       "argv": ["python3", "tools/fake.py"], "expectedTarget": TARGET,
                       "assetFiles": ["tools/fake.py", "tools/private.conf"]}}}
        self.write(self.root / ".playtest.json", self.config)
        self.assets([self.step()])

    def tearDown(self):
        self.env_patch.stop()
        self.temp.cleanup()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def assets(self, steps, scenario=None):
        self.write(self.directory / "play.json", {"version": 1, "scenarioName": "demo", "mode": "baseline", "steps": steps})
        self.write(self.directory / "scenario.json", scenario or {"setup": [], "cleanup": []})

    def step(self, sql="SELECT ? AS value", **updates):
        return {"stepNo": 1, "name": "Fake database", "type": "dbQuery", "database": "main",
                "sql": sql, "params": [7], "expect": {"value": 7}, **updates}

    def command(self, action, **updates):
        return {"action": action, "repoRoot": str(self.root), "play": "demo", **updates}

    def run_fake(self, **updates):
        output = io.StringIO()
        result = dispatch(self.command("run", allowEffects=True, **updates), output)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[-1]["type"], "run_finished")
        self.assertEqual(events[-1]["result"], result)
        return result, events

    def test_inspect_lint_catalog_only_fingerprint_no_execute(self):
        with patch("subprocess.Popen", side_effect=AssertionError("preview must not spawn")):
            inspected = dispatch(self.command("inspect"))
            self.assertTrue(dispatch(self.command("lint"))["ok"])
            self.assertEqual(dispatch(self.command("catalog"))["plays"][0]["slug"], "demo")
        self.assertTrue(inspected["requiresConfirmation"])
        self.assertTrue(all(effect["requiresConfirmation"] for effect in inspected["effects"]))
        hashes = inspected["snapshot"]["adapterAssets"]
        self.assertEqual(set(hashes), {"tools/fake.py", "tools/private.conf"})
        self.assertEqual(len(hashes["tools/private.conf"]["sha256"]), 64)
        self.assertNotIn("UNRELATED_PRIVATE_CONTENT_MUST_NOT_APPEAR", json.dumps(inspected))
        self.assertNotIn(FAKE, json.dumps(inspected))
        self.assertFalse((self.root / ".playtest").exists())

    def test_unapproved_reads_and_writes_rejected_before_spawn(self):
        for sql in ("SELECT 1", "UPDATE sample SET value=1"):
            self.assets([self.step(sql)])
            with patch("subprocess.Popen", side_effect=AssertionError("unapproved spawn")):
                with self.assertRaisesRegex(EngineError, "confirmation"):
                    dispatch(self.command("run"))
        self.assertFalse((self.root / ".playtest").exists())

    def test_direct_runner_rejects_unapproved_query(self):
        inspected = compile_request(self.command("inspect"))
        runner = Runner(inspected, {"allowEffects": False})
        try:
            with patch("subprocess.Popen", side_effect=AssertionError("unapproved spawn")):
                with self.assertRaisesRegex(EngineError, "confirmation"):
                    runner.query(self.step())
        finally:
            runner.events.close()

    def test_parameters_and_extraction_keep_json_types(self):
        self.assets([
            self.step(extract={"n": "value"}),
            self.step(stepNo=2, params=["${n}", True, None, [1, 2], {"x": "y"}],
                      expect={"value": 7, "readOnly": True, "allowWrite": True,
                              "params": [7, True, None, [1, 2], {"x": "y"}]})
        ])
        result, _ = self.run_fake()
        self.assertEqual(result["verdict"], "passed")
        payloads = [json.loads(line) for line in (Path(result["artifacts"]["result"]).parent / "requests.jsonl").read_text().splitlines()]
        self.assertEqual(payloads[1]["params"], [7, True, None, [1, 2], {"x": "y"}])
        self.assertEqual(payloads[1]["expectedTarget"], TARGET)
        self.assertEqual(payloads[1]["version"], 1)

    def test_readonly_hint_and_allowwrite_are_separate(self):
        self.assets([
            self.step("SELECT 1", expect={"readOnly": True, "allowWrite": True}),
            self.step("UPDATE sample SET value=1", stepNo=2, expect={"readOnly": False, "allowWrite": True}),
            self.step("UPDATE sample SET value=1", stepNo=3, readOnly=True, expect={"readOnly": True, "allowWrite": True}),
        ])
        result, _ = self.run_fake()
        self.assertEqual(result["verdict"], "passed")

    def test_invalid_and_empty_outputs_never_pass(self):
        for sql in ("EMPTY", "INVALID", "TABLE", "BAD_ROWS", "BAD_AFFECTED", "BAD_OK", "DUPLICATE_JSON", "NAN", "TOO_MANY_ROWS"):
            with self.subTest(sql=sql):
                self.assets([self.step(sql)])
                result, _ = self.run_fake()
                self.assertFalse(result["ok"])
                self.assertEqual(result["execution"], "failed")
                self.assertEqual(result["verdict"], "inconclusive")
                self.assertEqual(result["steps"][0]["errorCode"], "adapter_protocol")

    def test_nonzero_exit_is_failure_even_when_json_says_ok(self):
        self.assets([self.step("NONZERO")])
        result, _ = self.run_fake()
        self.assertFalse(result["ok"])
        self.assertEqual(result["steps"][0]["errorCode"], "adapter_exit")

    def test_empty_rows_fail_an_explicit_assertion(self):
        self.assets([self.step("NO_ROWS")])
        result, _ = self.run_fake()
        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "failed")
        self.assertEqual(result["execution"], "completed")

    def test_target_mismatch_and_wrong_types_fail(self):
        for sql in ("WRONG_TARGET", "BAD_TARGET_TYPE"):
            with self.subTest(sql=sql):
                self.assets([self.step(sql)])
                result, _ = self.run_fake()
                self.assertFalse(result["ok"])
                self.assertEqual(result["steps"][0]["errorCode"], "adapter_target")

    def test_adapter_failure_is_explicit_and_redacted(self):
        self.assets([self.step("ERROR")])
        result, events = self.run_fake()
        self.assertFalse(result["ok"])
        self.assertEqual(result["steps"][0]["errorCode"], "database")
        self.assertNotIn("do-not-leak", json.dumps(result) + json.dumps(events))

    def test_output_overflow_terminates_before_cleanup(self):
        self.assets([self.step("OVERFLOW")], {"cleanup": [self.step("SELECT cleanup", expect={"value": 7})]})
        result, events = self.run_fake()
        self.assertFalse(result["ok"])
        self.assertEqual(result["steps"][0]["errorCode"], "adapter_limit")
        self.assertEqual(result["cleanup"], "completed")
        self.assertTrue(any(event["type"] == "adapter_cleanup" and "143" in event["reason"] for event in events))
        child_pid = int((Path(result["artifacts"]["result"]).parent / "child-ready").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)
        self.assertTrue(any(event["type"] == "step_finished" and event.get("phase") == "cleanup" for event in events))

    def test_stderr_is_bounded_without_blocking_adapter(self):
        inspected = compile_request(self.command("inspect"))
        runner = Runner(inspected, {"allowEffects": True})
        try:
            _rows, observed = runner.query(self.step("STDERR"))
            self.assertLessEqual(len(observed["adapterStderr"].encode()), 4096)
            self.assertTrue(observed["adapterStderrTruncated"])
            self.assertTrue(observed["adapterStderr"].endswith("tail"))
        finally:
            runner.events.close()

    def test_step_timeout_stops_adapter_then_cleans(self):
        self.assets([self.step("SLEEP", timeoutSeconds=0.5)], {"cleanup": [self.step("SELECT cleanup")]})
        result, events = self.run_fake()
        self.assertFalse(result["ok"])
        self.assertEqual(result["steps"][0]["errorCode"], "adapter_timeout")
        self.assertEqual(result["cleanup"], "completed")
        self.assertTrue(any(event["type"] == "adapter_cleanup" and "143" in event["reason"] for event in events))
        child_pid = int((Path(result["artifacts"]["result"]).parent / "child-ready").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)

    def test_ignored_sigterm_requires_hard_kill_and_unknown_cleanup(self):
        self.assets([self.step("IGNORE_TERM", timeoutSeconds=0.5)], {"cleanup": [self.step("SELECT cleanup")]})
        result, events = self.run_fake()
        self.assertFalse(result["ok"])
        self.assertEqual(result["cleanup"], "unknown")
        self.assertEqual(result["steps"][0]["errorCode"], "adapter_timeout")
        self.assertTrue(any(event["type"] == "adapter_cleanup" and "hard kill" in event["reason"] for event in events))
        self.assertFalse(any(event["type"] == "step_started" and event.get("phase") == "cleanup" for event in events))

    def test_unhandled_sigterm_does_not_claim_child_teardown(self):
        self.assets([self.step("UNHANDLED_TERM", timeoutSeconds=0.5)], {"cleanup": [self.step("SELECT cleanup")]})
        result, events = self.run_fake()
        self.assertFalse(result["ok"])
        self.assertEqual(result["cleanup"], "unknown")
        self.assertTrue(any(event["type"] == "adapter_cleanup" and "-15" in event["reason"] for event in events))

    def test_unconfirmed_exit_after_kill_is_failed_not_completed(self):
        from command_db import _stop_and_wait
        class StillAlive:
            def poll(self):
                return None
            def terminate(self):
                pass
            def kill(self):
                pass
            def wait(self, timeout=None):
                raise subprocess.TimeoutExpired("fake", timeout)
        state = _stop_and_wait(StillAlive())
        self.assertEqual(state["status"], "failed")
        self.assertIn("still alive", state["reason"])

    def test_asset_change_invalidates_digest_without_execution(self):
        inspected = dispatch(self.command("inspect"))
        self.private.write_text("CHANGED_PRIVATE_CONTENT")
        refreshed = dispatch(self.command("inspect"))
        self.assertNotEqual(inspected["digest"], refreshed["digest"])
        self.assertNotIn("CHANGED_PRIVATE_CONTENT", json.dumps(refreshed))
        with patch("subprocess.Popen", side_effect=AssertionError("stale spawn")):
            with self.assertRaisesRegex(EngineError, "changed since inspect"):
                dispatch(self.command("run", allowEffects=True, expectedDigest=inspected["digest"]))

    def test_runtime_dependency_check_before_spawn(self):
        inspected = compile_request(self.command("inspect"))
        runner = Runner(inspected, {"allowEffects": True})
        self.adapter.write_text(FAKE + "\n# modified")
        try:
            with patch("subprocess.Popen", side_effect=AssertionError("stale spawn")):
                with self.assertRaisesRegex(EngineError, "dependency changed"):
                    runner.query(self.step())
        finally:
            runner.events.close()

    def test_argv_and_asset_escape_rejected(self):
        cases = [
            {"argv": ["bash", "-c", "echo unsafe"]},
            {"argv": ["python3", "-c", "print('unsafe')"]},
            {"argv": [sys.executable, "tools/fake.py"]},
            {"argv": ["python3", "tools/missing.py"]},
            {"assetFiles": ["../escape.conf"]},
            {"assetFiles": []},
            {"expectedTarget": {}},
        ]
        for fields in cases:
            with self.subTest(fields=fields):
                changed = {"databases": {"main": {**self.config["databases"]["main"], **fields}}}
                self.write(self.root / ".playtest.json", changed)
                with self.assertRaises(EngineError):
                    dispatch(self.command("inspect"))

    def test_parameter_file_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory(prefix="playtest-command-outside-") as temp:
            outside = Path(temp) / "config.json"
            outside.write_text("{}")
            link = self.root / "tools" / "escaped.json"
            link.symlink_to(outside)
            self.config["databases"]["main"]["argv"].append("--config=tools/escaped.json")
            self.write(self.root / ".playtest.json", self.config)
            with self.assertRaises(EngineError):
                dispatch(self.command("inspect"))

    def test_command_params_objects_rejected_before_execution(self):
        self.assets([self.step(params={"value": 7})])
        self.assertFalse(dispatch(self.command("lint"))["ok"])

    def test_setup_failure_and_command_cleanup_events(self):
        self.assets([self.step()], {"setup": [self.step("ERROR")], "cleanup": [self.step("SELECT cleanup")]})
        result, events = self.run_fake()
        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "inconclusive")
        self.assertEqual(result["cleanup"], "completed")
        self.assertFalse(any(event["type"] == "step_started" and event.get("phase") == "play" for event in events))
        self.assertTrue(any(event["type"] == "step_finished" and event.get("phase") == "cleanup" for event in events))

    def test_cancellation_reaps_adapter_child_before_cleanup(self):
        self.assets([self.step("CANCEL"), self.step("SELECT should-not-run", stepNo=2)],
                    {"cleanup": [self.step("SELECT cleanup")]})
        run_id = "cancel-adapter"
        run_dir = self.root / ".playtest" / "runs" / run_id
        process = subprocess.Popen([sys.executable, str(ENGINE / "cli.py")], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        process.stdin.write(json.dumps(self.command("run", allowEffects=True, runId=run_id)))
        process.stdin.close()
        process.stdin = None
        try:
            deadline = time.monotonic() + 5
            while not (run_dir / "child-ready").exists() and time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                time.sleep(0.01)
            self.assertTrue((run_dir / "child-ready").exists(), "fake adapter did not start")
            child_pid = int((run_dir / "child-ready").read_text())
            process.send_signal(signal.SIGTERM)
            output, stderr = process.communicate(timeout=10)
        except BaseException:
            process.kill()
            process.communicate()
            raise
        self.assertEqual(process.returncode, 130, stderr)
        events = [json.loads(line) for line in output.splitlines()]
        result = events[-1]["result"]
        self.assertEqual(result["execution"], "cancelled")
        self.assertEqual(result["cleanup"], "completed")
        requests = [json.loads(line) for line in (run_dir / "requests.jsonl").read_text().splitlines()]
        self.assertEqual([item["sql"] for item in requests], ["CANCEL", "SELECT cleanup"])
        self.assertFalse((run_dir / "late-child-write").exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)


if __name__ == "__main__":
    unittest.main()
