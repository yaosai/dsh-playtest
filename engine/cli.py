#!/usr/bin/env python3
"""One stdin JSON command; JSON replies, or streaming NDJSON for run.

Usage: python3 engine/cli.py < request.json
No DSH, third-party packages, business defaults, or shell commands are required.
"""
from __future__ import annotations

import json
import re
import sys

from common import EngineError, MAX_ASSET_BYTES, compile_request, redact, repository, safe_path
from linter import catalog, lint
from player import RunCancelled, run, timestamp


def scaffold(command):
    root = repository(command.get("repoRoot"))
    name = command.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise EngineError("name must be a kebab-case slug")
    directory = safe_path(root, "test-plays/" + name)
    if directory.exists():
        raise EngineError("Play directory already exists; scaffold does not overwrite assets", "asset_exists")
    play = {
        "version": 1, "scenarioName": name, "description": "Local mock demonstration; no business-system calls",
        "mode": "baseline", "claims": [{"id": "local-contract", "description": "Owned mock returns its declared response",
                                           "basis": "scenario.json declares the local demonstration contract"}],
        "steps": [
            {"stepNo": 1, "name": "Call owned local mock", "type": "http", "method": "POST",
             "path": "${mock.demo.url}/echo", "body": {"runId": "${runId}"},
             "expect": {"status": 200, "json": {"$.ok": True, "$.value": 42}},
             "extractFromResponse": {"value": "$.value"}},
            {"stepNo": 2, "name": "Verify the mock really received one call", "type": "mockVerify",
             "mock": "demo", "method": "POST", "path": "/echo", "count": 1},
        ],
    }
    scenario = {"variables": {}, "setup": [], "cleanup": [],
                "mocks": [{"id": "demo", "port": 0, "routes": [
                    {"method": "POST", "path": "/echo", "status": 200, "body": {"ok": True, "value": 42}}
                ]}]}
    directory.mkdir(parents=True)
    for filename, value in (("play.json", play), ("scenario.json", scenario)):
        (directory / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "slug": name, "created": str(directory),
            "play": str(directory / "play.json"), "scenario": str(directory / "scenario.json"),
            "hint": "Local mock only. Inspect or run the slug; no effects approval is required."}


def error_result(command, exc):
    return {"ok": False, "error": str(redact(str(exc))), "code": getattr(exc, "code", "configuration")}


def dispatch(command, output=None):
    if not isinstance(command, dict):
        raise EngineError("stdin request must be a JSON object")
    for field in ("allowEffects", "skipCleanup"):
        if field in command and not isinstance(command[field], bool):
            raise EngineError(field + " must be a boolean")
    action = command.get("action")
    if action == "catalog":
        return catalog(command)
    if action == "lint":
        return lint(command)
    if action == "scaffold":
        return scaffold(command)
    if action not in ("inspect", "run"):
        raise EngineError("action must be catalog, inspect, lint, scaffold, or run")
    inspected = compile_request(command)
    if action == "inspect":
        return {**inspected, "snapshot": redact(inspected["snapshot"])}
    if not inspected["ok"]:
        raise EngineError("Invalid selected assets: " + "; ".join(i["message"] for i in inspected["issues"] if i["level"] == "error"), "invalid_assets")
    expected = command.get("expectedDigest")
    if expected is not None and expected != inspected["digest"]:
        raise EngineError("Assets or configuration changed since inspect; refresh the preview and confirmation", "stale_digest")
    if inspected["requiresConfirmation"] and not command.get("allowEffects", False):
        raise EngineError("Selected effects require explicit confirmation; inspect.effects identifies them", "effects_required")
    try:
        return run(inspected, command, output)
    except BaseException as exc:
        exc.run_may_have_started = True
        raise


def main():
    command = {}
    try:
        text = sys.stdin.read(MAX_ASSET_BYTES + 1)
        if len(text.encode("utf-8")) > MAX_ASSET_BYTES:
            raise EngineError("stdin request exceeds 4 MiB")
        try:
            command = json.loads(text)
        except ValueError as exc:
            raise EngineError("stdin request is not valid JSON") from exc
        result = dispatch(command, sys.stdout)
        if command.get("action") != "run":
            print(json.dumps(result, ensure_ascii=False, default=str), flush=True)
        if command.get("action") == "run":
            return result.get("exitCode", 0 if result.get("ok") else 1)
        return 0 if result.get("ok") else 2
    except (Exception, KeyboardInterrupt) as exc:
        result = error_result(command, exc)
        if isinstance(command, dict) and command.get("action") == "run":
            code = 130 if isinstance(exc, (KeyboardInterrupt, RunCancelled)) else 2
            result.update(runId=command.get("runId"), ownerSessionId=command.get("ownerSessionId"),
                          status="cancelled" if code == 130 else "failed", verdict="inconclusive",
                          execution="cancelled" if code == 130 else "failed", cleanup="unknown" if getattr(exc, "run_may_have_started", False) else "completed",
                          steps=[], assertions=[], artifacts={}, exitCode=code)
            print(json.dumps({"seq": 1, "type": "run_finished", "runId": command.get("runId"),
                              "time": timestamp(), "result": result}, ensure_ascii=False), flush=True)
            return code
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
