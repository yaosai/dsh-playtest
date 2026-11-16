"""Deterministic stdlib runner: HTTP, mocks, SQLite and trusted command adapters.

This module never starts a business application, calls an LLM, infers a business
oracle, or changes source plays. Use cli.py's stdin JSON protocol.
"""
from __future__ import annotations

import copy
import json
import re
import signal
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, request
from urllib.parse import urlsplit, urljoin, quote

from common import (ASSETS, CACHE, EngineError, MISSING, MAX_RESPONSE_BYTES, MAX_ROWS, ensure_assets_ignore,
                    CLEANUP_SECONDS, RUNS, equal, evidence, origin, redact,
                    safe_path, substitute, json_path, secret_values, validate_steps)


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class RunCancelled(Exception):
    pass


class AssertionFailed(Exception):
    pass


class EventWriter:
    def __init__(self, run_id, path, output=None, secrets=None):
        self.run_id = run_id
        self.output = output
        self.secrets = secrets or set()
        self.sequence = 0
        self.lock = threading.RLock()
        self.file = path.open("x", encoding="utf-8")

    def emit(self, kind, **fields):
        with self.lock:
            self.sequence += 1
            event = redact({"seq": self.sequence, "type": kind, "runId": self.run_id,
                            "time": timestamp(), **fields}, self.secrets)
            line = json.dumps(event, ensure_ascii=False, default=str) + "\n"
            self.file.write(line)
            self.file.flush()
            if self.output:
                try:
                    self.output.write(line)
                    self.output.flush()
                except (BrokenPipeError, OSError):
                    # Artifact collection/cleanup must survive a disconnected UI.
                    self.output = None
            return event

    def close(self):
        self.file.close()


class RejectRedirects(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise EngineError("HTTP redirects are disabled (including cross-origin redirects)", "origin_restriction")


class Mock:
    def __init__(self, spec, variables, events, play):
        self.id = spec["id"]
        self.spec = spec
        self.variables = variables
        self.events = events
        self.play = play
        self.lock = threading.Lock()
        self.counts = {}
        self.total = 0
        self.records = []
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def answer(self):
                path = urlsplit(self.path).path
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    size = MAX_RESPONSE_BYTES + 1
                if size < 0 or size > MAX_RESPONSE_BYTES:
                    self.send_error(413)
                    return
                raw = self.rfile.read(size) if size else b""
                try:
                    body = json.loads(raw.decode("utf-8")) if raw else None
                except (ValueError, UnicodeError):
                    body = raw.decode("utf-8", errors="replace")
                with mock.lock:
                    mock.total += 1
                    key = (self.command, path)
                    mock.counts[key] = mock.counts.get(key, 0) + 1
                    record = evidence({"method": self.command, "path": self.path,
                                       "headers": dict(self.headers), "body": body})
                    if len(mock.records) < MAX_ROWS:
                        mock.records.append({"method": self.command, "path": path, "evidence": record})
                mock.events.emit("mock_request", play=mock.play, mock=mock.id,
                                 method=self.command, path=path, evidence=record)
                route = next((r for r in mock.spec.get("routes", [])
                              if r.get("path") == path and str(r.get("method", "GET")).upper() in (self.command, "*")), None)
                status = int(route.get("status", 200)) if route else 404
                payload = substitute(route.get("body"), mock.variables) if route else {"error": "No matching mock route"}
                encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                if self.command != "HEAD":
                    try:
                        self.wfile.write(encoded)
                    except (BrokenPipeError, ConnectionResetError):
                        pass

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = answer

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", spec.get("port", 0)), Handler)
        self.server.daemon_threads = True
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.05), daemon=True)
        self.thread.start()

    def count(self, path=None, method=None):
        with self.lock:
            return sum(n for (m, p), n in self.counts.items()
                       if (path is None or path == p) and (method is None or method.upper() == m))

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)


class Runner:
    def __init__(self, inspected, command, output=None):
        self.inspected = inspected
        self.snapshot = copy.deepcopy(inspected["snapshot"])
        self.secrets = secret_values(self.snapshot)
        self.root = Path(self.snapshot["repoRoot"])
        self.command = command
        self.run_id = command.get("runId") or (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:12])
        import re
        if not isinstance(self.run_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", self.run_id):
            raise EngineError("runId must be a safe identifier", "path_restriction")
        runs_dir = safe_path(self.root, RUNS)
        # npm strips .gitignore from packages, and copied-in assets bring no ignore rule;
        # writing evidence is the moment a repository demonstrably needs one.
        ensure_assets_ignore(self.root)
        self.run_dir = safe_path(self.root, str(runs_dir / self.run_id))
        if self.run_dir.exists():
            raise EngineError("Run id already exists; historical runs are immutable", "run_exists")
        runs_dir.mkdir(parents=True, exist_ok=True)
        self.run_dir.mkdir()
        self.artifacts = {"snapshot": str(self.run_dir / "snapshot.json"),
                          "events": str(self.run_dir / "events.jsonl"),
                          "result": str(self.run_dir / "result.json")}
        public_snapshot = redact({"digest": inspected["digest"], **self.snapshot})
        (self.run_dir / "snapshot.json").write_text(json.dumps(public_snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
        self.events = EventWriter(self.run_id, self.run_dir / "events.jsonl", output, self.secrets)
        self.cancelled = threading.Event()
        self.cleaning = False
        self.cleanup_deadline = None
        self.mocks = {}
        self.connections = {}
        self.variables = {}
        self.item = None
        self.steps = []
        self.assertions = []
        self.started = timestamp()
        self.exit_code = 0
        self.current_phase = None
        self.original_signal_handler = None
        self.adapter_processes = set()
        self.command_children_unsettled = False
        self.adapter_cleanup_status = "completed"
        self.adapter_cleanup_reasons = []

    def cancel(self):
        self.cancelled.set()

    def checkpoint(self):
        if self.cleaning:
            if self.cleanup_deadline and time.monotonic() >= self.cleanup_deadline:
                raise EngineError("Cleanup exceeded its independent time limit", "cleanup_timeout")
        elif self.cancelled.is_set():
            raise RunCancelled()

    def install_signal_handler(self):
        if threading.current_thread() is not threading.main_thread():
            return
        self.original_signal_handler = signal.getsignal(signal.SIGTERM)
        def terminate(_signum, _frame):
            self.cancelled.set()
            if not self.cleaning:
                raise RunCancelled()
        signal.signal(signal.SIGTERM, terminate)

    def restore_signal_handler(self):
        if self.original_signal_handler is not None:
            signal.signal(signal.SIGTERM, self.original_signal_handler)

    def wait(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.checkpoint()
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        self.checkpoint()

    def timeout(self, requested):
        if self.cleaning:
            return max(0.001, min(requested, self.cleanup_deadline - time.monotonic()))
        return requested

    def http(self, step):
        path = step["path"]
        if not isinstance(path, str):
            raise EngineError("Resolved HTTP path is not a string")
        base_url = step.get("baseUrl") or self.item.get("baseUrl")
        if path.startswith(("http://", "https://")):
            url = path
        elif base_url:
            url = urljoin(base_url.rstrip("/") + "/", path)
        else:
            raise EngineError("HTTP path has no explicit target/baseUrl", "unknown_target")
        selected_origin = origin(url)
        own_origins = {origin(m.url) for m in self.mocks.values()}
        allowed_origins = set(own_origins)
        if base_url:
            allowed_origins.add(origin(base_url))
        if selected_origin not in allowed_origins:
            raise EngineError("HTTP origin is outside selected target and owned mocks", "origin_restriction")
        if selected_origin not in own_origins and not self.command.get("allowEffects"):
            raise EngineError("Non-owned HTTP request requires explicit effects confirmation", "effects_required")
        headers = {str(k): str(v) for k, v in step.get("headers", {}).items()}
        method = str(step.get("method", "GET")).upper()
        data = json.dumps(step["body"], ensure_ascii=False).encode("utf-8") if "body" in step else None
        if data is not None:
            headers.setdefault("Content-Type", "application/json")
        if data is not None and len(data) > MAX_RESPONSE_BYTES:
            raise EngineError("HTTP request body exceeds 1 MiB", "response_limit")
        req = request.Request(url, data=data, headers=headers, method=method)
        opener = request.build_opener(request.ProxyHandler({}), RejectRedirects())
        try:
            try:
                response = opener.open(req, timeout=self.timeout(float(step.get("httpTimeoutSeconds", 15))))
            except error.HTTPError as exc:
                response = exc
            with response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise EngineError("HTTP response exceeds 1 MiB; assertions were not evaluated against truncated data", "response_limit")
                status = response.code
                response_headers = dict(response.headers)
        except RunCancelled:
            raise
        except EngineError:
            raise
        except (error.URLError, OSError, ValueError) as exc:
            raise EngineError("HTTP transport failed: " + str(exc), "transport") from exc
        try:
            payload = json.loads(raw.decode("utf-8"))
            is_json = True
        except (UnicodeError, ValueError):
            payload = raw.decode("utf-8", errors="replace")
            is_json = False
        observation = {"request": {"method": method, "url": url, "headers": headers, "body": step.get("body")},
                       "response": {"status": status, "headers": response_headers, "body": payload}}
        expected = step.get("expect", {})
        if status >= 400 and "status" not in expected:
            raise EngineError("HTTP error status " + str(status) + " without explicit expect.status", "http_status")
        return status, payload, is_json, observation

    def database(self, name, sql):
        spec = self.snapshot["config"].get("databases", {}).get(name)
        if not spec:
            raise EngineError("Unknown database: " + str(name), "unknown_database")
        path_text = substitute(spec["path"], self.variables)
        path = safe_path(self.root, path_text)
        owned = path.is_relative_to(self.run_dir)
        can_write = owned or bool(self.command.get("allowEffects"))
        if not path.exists() and not can_write:
            raise EngineError("Read-only SQLite database does not exist", "missing_database")
        from common import is_read_sql
        if not path.exists() and is_read_sql(sql):
            raise EngineError("Read-only access does not create SQLite databases", "missing_database")
        if name in self.connections:
            conn, original_path = self.connections[name]
            if path != original_path:
                raise EngineError("Database path changed during run", "path_restriction")
            return conn
        if can_write:
            path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(path), timeout=self.timeout(2))
        else:
            conn = sqlite3.connect("file:" + quote(str(path), safe="/") + "?mode=ro", uri=True, timeout=self.timeout(2))
        conn.row_factory = sqlite3.Row
        if hasattr(conn, "setlimit"):
            conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_RESPONSE_BYTES)
            conn.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, MAX_RESPONSE_BYTES)
        writes = {getattr(sqlite3, name) for name in (
            "SQLITE_INSERT", "SQLITE_UPDATE", "SQLITE_DELETE", "SQLITE_CREATE_INDEX",
            "SQLITE_CREATE_TABLE", "SQLITE_CREATE_TEMP_INDEX", "SQLITE_CREATE_TEMP_TABLE",
            "SQLITE_CREATE_TEMP_TRIGGER", "SQLITE_CREATE_TEMP_VIEW", "SQLITE_CREATE_TRIGGER",
            "SQLITE_CREATE_VIEW", "SQLITE_DROP_INDEX", "SQLITE_DROP_TABLE", "SQLITE_DROP_TEMP_INDEX",
            "SQLITE_DROP_TEMP_TABLE", "SQLITE_DROP_TEMP_TRIGGER", "SQLITE_DROP_TEMP_VIEW",
            "SQLITE_DROP_TRIGGER", "SQLITE_DROP_VIEW", "SQLITE_ALTER_TABLE", "SQLITE_REINDEX",
            "SQLITE_ANALYZE", "SQLITE_CREATE_VTABLE", "SQLITE_DROP_VTABLE") if hasattr(sqlite3, name)}
        def authorize(action, arg1, arg2, _database, _source):
            if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_FUNCTION and str(arg2).lower() in ("load_extension", "writefile", "readfile"):
                return sqlite3.SQLITE_DENY
            # PRAGMA may change persistent settings or load schema-adjacent paths.
            if action == sqlite3.SQLITE_PRAGMA:
                return sqlite3.SQLITE_DENY
            if action in writes and not can_write:
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        conn.set_authorizer(authorize)
        conn.set_progress_handler(lambda: int((not self.cleaning and self.cancelled.is_set()) or
                                              (self.cleaning and time.monotonic() >= self.cleanup_deadline)), 1000)
        self.connections[name] = (conn, path)
        return conn

    def query(self, step):
        sql = step["sql"]
        name = step.get("database", "main")
        spec = self.snapshot["config"].get("databases", {}).get(name)
        if not spec:
            raise EngineError("Unknown database: " + str(name), "unknown_database")
        if spec.get("driver") == "command":
            from command_db import query as command_query
            return command_query(self, name, spec, step)
        conn = self.database(name, sql)
        try:
            cursor = conn.execute(sql, step.get("params", []))
            rows = [dict(row) for row in cursor.fetchmany(MAX_ROWS + 1)] if cursor.description else []
            if len(rows) > MAX_ROWS:
                raise EngineError("SQLite result exceeds 1000 rows; no truncated assertion evaluation", "response_limit")
            conn.commit()
            return rows, {"database": step.get("database", "main"), "sql": sql,
                          "params": step.get("params", []), "rows": rows,
                          "rowsAffected": max(0, cursor.rowcount)}
        except sqlite3.Error as exc:
            if self.cancelled.is_set() and not self.cleaning:
                raise RunCancelled() from exc
            raise EngineError("SQLite query failed: " + str(exc), "database") from exc

    def assertion(self, record, check, actual, expected, observation, membership=False):
        ok = actual in expected if membership else equal(actual, expected)
        assertion_id = record["id"] + ":" + str(record["assertionCount"] + 1)
        item = {"id": assertion_id, "play": self.item["slug"], "stepId": record["id"],
                "phase": record["phase"], "check": check,
                # Which embedded check (if any) produced this: without it a failing column
                # is indistinguishable from the action's own expectation.
                **({"ofCheck": record.get("currentCheck")} if record.get("currentCheck") else {}),
                "expected": evidence(expected), "actual": evidence("<missing>" if actual is MISSING else actual),
                "ok": ok, "status": "passed" if ok else "failed", "evidence": evidence(observation)}
        self.assertions.append(item)
        record["assertionCount"] += 1
        self.events.emit("assertion", assertion=item, play=self.item["slug"], stepId=record["id"])
        return ok

    @staticmethod
    def _brief(value, limit=90):
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        text = text.replace("\n", " ")
        return text if len(text) <= limit else text[:limit - 1] + "…"

    def mismatch_report(self, record):
        """Name the assertions that actually broke, with expected and observed values.

        "Explicit assertion mismatch" forces anyone reading the run — human or a follow-up
        agent — to open the evidence blob to learn that the service replied 401.
        """
        broken = [item for item in self.assertions if item["stepId"] == record["id"] and not item["ok"]]
        parts = []
        for item in broken[:3]:
            where = (item.get("ofCheck") + " ") if item.get("ofCheck") else ""
            parts.append(where + str(item["check"]) + " expected " + self._brief(item["expected"].get("data"))
                         + ", actual " + self._brief(item["actual"].get("data")))
        if len(broken) > 3:
            parts.append("(另有 " + str(len(broken) - 3) + " 项不匹配)")
        return "assertion mismatch: " + "; ".join(parts) if parts else "Explicit assertion mismatch"

    def unit(self, record, step, kind):
        """Run one action or verification; assertions land on the owning step."""
        failures = False
        if kind == "wait":
            self.wait(float(step["seconds"]))
            observation = {"seconds": step["seconds"]}
        elif kind == "http":
            status, payload, is_json, observation = self.http(step)
            expectation = step.get("expect", {})
            if "status" in expectation:
                wanted = expectation["status"]
                failures |= not self.assertion(record, "http.status", status, wanted, observation, isinstance(wanted, list))
            for expression, wanted in expectation.get("json", {}).items():
                actual = json_path(payload, expression) if is_json else MISSING
                failures |= not self.assertion(record, expression, actual, wanted, observation)
            for variable, expression in step.get("extractFromResponse", {}).items():
                actual = json_path(payload, expression) if is_json else MISSING
                if actual is MISSING:
                    raise EngineError("Response extraction path is missing: " + expression, "missing_variable")
                self.variables[variable] = actual
        elif kind in ("dbQuery", "dbWait"):
            expectation = step.get("expect", {})
            deadline = time.monotonic() + float(step.get("timeoutSeconds", 60))
            attempts = 0
            while True:
                self.checkpoint()
                rows, observation = self.query(step)
                attempts += 1
                matches = bool(rows) and all(equal(rows[0].get(k, MISSING), v) for k, v in expectation.items())
                if kind == "dbQuery" or matches or time.monotonic() >= deadline:
                    break
                self.events.emit("step_progress", play=self.item["slug"], stepId=record["id"], attempts=attempts,
                                 evidence=evidence({"rows": rows, "waitingFor": expectation}))
                self.wait(min(float(step.get("intervalSeconds", 1)), max(0, deadline - time.monotonic())))
            observation["attempts"] = attempts
            for column, wanted in expectation.items():
                actual = rows[0].get(column, MISSING) if rows else MISSING
                failures |= not self.assertion(record, column, actual, wanted, observation)
            for variable, column in step.get("extract", {}).items():
                if not rows or column not in rows[0]:
                    raise EngineError("Database extraction column missing: " + column, "missing_variable")
                self.variables[variable] = rows[0][column]
        elif kind == "mockVerify":
            mock = self.mocks.get(step["mock"])
            if mock is None:
                raise EngineError("Unknown mock: " + step["mock"], "unknown_mock")
            actual = mock.count(step.get("path"), step.get("method"))
            observation = {"mock": mock.id, "path": step.get("path"), "method": step.get("method"),
                           "count": actual, "total": mock.total, "requests": mock.records,
                           "requestsTruncated": mock.total > len(mock.records)}
            failures |= not self.assertion(record, "mock.requestCount", actual, step["count"], observation)
        else:
            raise EngineError("Unsupported step type: " + str(kind))
        return failures, observation

    def execute_step(self, source, phase, index):
        self.checkpoint()
        number = source.get("stepNo", index + 1)
        record = {"id": self.item["slug"] + ":" + phase + ":" + str(number),
                  "play": self.item["slug"], "phase": phase, "stepNo": number,
                  "name": source.get("name", "Step " + str(number)),
                  "type": source.get("type", "http"), "status": "observed", "ok": True,
                  "assertionCount": 0, "checks": [], "evidence": evidence({})}
        self.events.emit("step_started", step=record.copy(), play=self.item["slug"], phase=phase)
        started = time.monotonic()
        try:
            step = substitute(source, self.variables)
            runtime_issues = validate_steps([step], self.item["path"], phase, allow_variables=False)
            if runtime_issues:
                raise EngineError("Resolved step is invalid: " + "; ".join(i["message"] for i in runtime_issues), "invalid_step")
            kind = record["type"]
            failures, observation = self.unit(record, step, kind)
            # Verifications are part of this step: the step only passes when its
            # action AND every check passed. They never become steps of their own.
            check_error = None
            for position, check in enumerate(step.get("checks") or []):
                self.checkpoint()
                entry = {"index": position + 1,
                         "name": check.get("name") or "Check " + str(position + 1),
                         "type": check.get("type"), "status": "observed", "assertionCount": 0}
                before = record["assertionCount"]
                started_check = time.monotonic()
                record["currentCheck"] = entry["name"]
                pending = None
                try:
                    check_failures, check_observation = self.unit(record, check, check.get("type"))
                except RunCancelled as exc:
                    entry.update(status="cancelled", error="Run cancelled")
                    pending = exc
                except AssertionFailed as exc:
                    entry.update(status="failed", error=str(exc))
                    pending = exc
                except BaseException as exc:
                    entry.update(status="error", error=str(redact(str(exc))),
                                 errorCode=getattr(exc, "code", "execution"))
                    check_error = exc
                else:
                    failures |= check_failures
                    entry["status"] = ("failed" if check_failures
                                       else "passed" if record["assertionCount"] > before else "observed")
                    if check_failures:
                        # A check that merely disagreed used to carry no text at all: the run
                        # said "failed" and the reason stayed buried in the assertions list.
                        entry["error"] = self.mismatch_report(record)
                    entry["evidence"] = evidence(check_observation)
                finally:
                    # Internal marker only: it must never reach the returned step record.
                    record.pop("currentCheck", None)
                    entry["assertionCount"] = record["assertionCount"] - before
                    entry["durationMs"] = round((time.monotonic() - started_check) * 1000)
                record["checks"].append(entry)
                if pending is not None:
                    raise pending
                if check_error is not None:
                    break

            record["evidence"] = evidence(observation)
            self.checkpoint()
            if check_error is not None:
                raise check_error
            if failures:
                raise AssertionFailed(self.mismatch_report(record))

            record["status"] = "passed" if record["assertionCount"] else "observed"
        except RunCancelled:
            record.update(status="cancelled", ok=False, error="Run cancelled")
            raise
        except AssertionFailed as exc:
            record.update(status="failed", ok=False, error=str(exc))
            raise
        except BaseException as exc:
            record.update(status="failed", ok=False, error=str(redact(str(exc))),
                          errorCode=getattr(exc, "code", "execution"))
            raise
        finally:
            record["durationMs"] = round((time.monotonic() - started) * 1000)
            self.steps.append(record)
            self.events.emit("step_finished", step=record, play=self.item["slug"], phase=phase)

    def phase(self, phase, steps, keep_going=False):
        self.current_phase = phase
        self.events.emit("phase_started", play=self.item["slug"], phase=phase)
        errors = []
        try:
            for index, step in enumerate(steps):
                try:
                    self.execute_step(step, phase, index)
                except (Exception, RunCancelled) as exc:
                    if not keep_going:
                        raise
                    errors.append(str(exc))
            if errors:
                raise EngineError("Cleanup failures: " + "; ".join(errors), "cleanup")
        finally:
            self.events.emit("phase_finished", play=self.item["slug"], phase=phase)

    def play(self, item):
        self.item = item
        # `runShort` exists because real columns are narrow: a 32-hex runId does not fit an
        # nvarchar(19) business code. Tail, not head, because a self-generated id starts with a
        # timestamp and would otherwise repeat across runs in the same few minutes.
        short = re.sub(r"[^0-9a-z]", "", self.run_id.lower())[-12:] or self.run_id[:12]
        self.variables = {"runId": self.run_id, "runShort": short, "runDir": str(self.run_dir)}
        variables = copy.deepcopy(item["scenario"].get("variables", {}))
        if any(name in variables for name in ("runId", "runShort", "runDir", "mock")):
            raise EngineError("scenario variables cannot replace reserved runId/runDir/mock")
        self.variables.update(variables)
        self.mocks = {}
        self.connections = {}
        step_offset, assertion_offset = len(self.steps), len(self.assertions)
        execution, cleanup = "completed", "completed"
        run_error = None
        try:
            self.checkpoint()
            for spec in item["mocks"]:
                self.checkpoint()
                mock = Mock(spec, self.variables, self.events, item["slug"])
                self.mocks[spec["id"]] = mock
                self.variables["mock." + spec["id"] + ".url"] = mock.url
                self.events.emit("mock_started", play=item["slug"], mock=spec["id"], url=mock.url)
            # Custom variables may reference run identifiers and owned mock URLs.
            for _ in range(len(variables) + 1):
                previous = copy.deepcopy(self.variables)
                for name, value in variables.items():
                    self.variables[name] = substitute(value, self.variables)
                if previous == self.variables:
                    break
            self.phase("prepare", item["phases"].get("prepare", []))
            self.phase("setup", item["phases"]["setup"])
            self.phase("play", item["phases"]["play"])
        except RunCancelled:
            execution = "cancelled"
            run_error = "Run cancelled"
            self.exit_code = 130
        except AssertionFailed as exc:
            run_error = str(exc)
            self.exit_code = max(self.exit_code, 1)
            if self.current_phase == "setup":
                execution = "failed"
            if self.current_phase == "prepare":
                execution = "blocked"
                self.exit_code = 2  # environment not ready, not a business failure
        except Exception as exc:
            execution = "blocked" if self.current_phase == "prepare" else "failed"
            run_error = str(redact(str(exc)))
            code = getattr(exc, "code", "execution")
            if self.exit_code != 130:
                self.exit_code = 2 if execution == "blocked" or code in (
                    "transport", "unknown_target", "missing_database", "path_restriction",
                    "origin_restriction", "effects_required") else 1
            self.events.emit("execution_error", play=item["slug"], error=run_error, code=code)
        finally:
            self.cleaning = True
            self.cleanup_deadline = time.monotonic() + float(item.get("cleanupSeconds", CLEANUP_SECONDS))
            try:
                if execution == "blocked":
                    cleanup = "skipped"
                    self.events.emit("phase_started", play=item["slug"], phase="cleanup")
                    self.events.emit("phase_finished", play=item["slug"], phase="cleanup", status="skipped",
                                     reason="场景准备未通过，剧本没有执行，无需清理")
                elif self.command.get("skipCleanup"):
                    cleanup = "skipped"
                    self.events.emit("phase_started", play=item["slug"], phase="cleanup")
                    self.events.emit("phase_finished", play=item["slug"], phase="cleanup", status="skipped")
                elif getattr(self, "command_children_unsettled", False):
                    cleanup = self.adapter_cleanup_status
                    self.events.emit("cleanup_error", play=item["slug"], status=cleanup,
                                     error="Unsafe to run cleanup: " + "; ".join(self.adapter_cleanup_reasons or ["adapter descendant cleanup is unknown"]))
                else:
                    self.phase("cleanup", item["phases"]["cleanup"], keep_going=True)
            except Exception as exc:
                cleanup = "failed"
                self.events.emit("cleanup_error", play=item["slug"], error=str(redact(str(exc))))
                if self.exit_code == 0:
                    self.exit_code = 1
            for name, (conn, _path) in list(self.connections.items()):
                try:
                    conn.close()
                except Exception as exc:
                    cleanup = "failed"
                    self.events.emit("cleanup_error", play=item["slug"], database=name, error=str(exc))
            for name, mock in list(self.mocks.items()):
                try:
                    mock.stop()
                    self.events.emit("mock_stopped", play=item["slug"], mock=name, requests=mock.total)
                except Exception as exc:
                    cleanup = "failed"
                    self.events.emit("cleanup_error", play=item["slug"], mock=name, error=str(exc))
            self.cleaning = False
            self.mocks = {}
            self.connections = {}
        steps = self.steps[step_offset:]
        assertions = self.assertions[assertion_offset:]
        main_assertions = [a for a in assertions if a["phase"] == "play"]
        verdict = "failed" if any(not a["ok"] for a in main_assertions) else "passed" if main_assertions and execution == "completed" else "inconclusive"
        ok = execution == "completed" and verdict != "failed" and cleanup in ("completed", "skipped")
        return {"play": item["slug"], "name": item["play"]["scenarioName"], "mode": item["play"].get("mode", "explore"),
                "ok": ok, "verdict": verdict, "execution": execution, "cleanup": cleanup,
                "steps": steps, "assertions": assertions, "error": run_error}

    def run(self):
        subruns = []
        self.install_signal_handler()
        self.events.emit("run_started", digest=self.inspected["digest"], ownerSessionId=self.command.get("ownerSessionId"),
                         artifacts=self.artifacts, plays=[i["slug"] for i in self.snapshot["plays"]])
        try:
            for item in self.snapshot["plays"]:
                if self.cancelled.is_set():
                    break
                subruns.append(self.play(item))
                if self.command_children_unsettled:
                    break
        except RunCancelled:
            self.exit_code = 130
        except Exception as exc:
            if self.exit_code != 130:
                self.exit_code = 1
            self.events.emit("execution_error", error=str(redact(str(exc))), code=getattr(exc, "code", "execution"))
        finally:
            self.restore_signal_handler()
        # A blocked play means the environment was never ready; it is neither a
        # business assertion failure nor a completed run.
        execution = ("cancelled" if self.cancelled.is_set() or any(s["execution"] == "cancelled" for s in subruns)
                     else "blocked" if any(s["execution"] == "blocked" for s in subruns)
                     else "failed" if len(subruns) != len(self.snapshot["plays"]) or any(s["execution"] == "failed" for s in subruns)
                     else "completed")
        cleanup = "failed" if any(s["cleanup"] == "failed" for s in subruns) else "unknown" if any(s["cleanup"] == "unknown" for s in subruns) else "skipped" if any(s["cleanup"] == "skipped" for s in subruns) else "completed"
        verdict = "failed" if any(s["verdict"] == "failed" for s in subruns) else "passed" if subruns and all(s["verdict"] == "passed" for s in subruns) and execution == "completed" else "inconclusive"
        ok = execution == "completed" and cleanup in ("completed", "skipped") and verdict != "failed"
        result = {"ok": ok, "runId": self.run_id, "ownerSessionId": self.command.get("ownerSessionId"),
                  "status": "cancelled" if execution == "cancelled" else "completed" if ok else "failed",
                  "verdict": verdict, "execution": execution, "cleanup": cleanup,
                  "digest": self.inspected["digest"], "startedAt": self.started, "finishedAt": timestamp(),
                  "steps": self.steps, "assertions": self.assertions, "artifacts": self.artifacts}
        if len(self.snapshot["plays"]) > 1:
            result["subRuns"] = subruns
        if execution == "cancelled":
            self.exit_code = 130
        elif not ok and self.exit_code == 0:
            self.exit_code = 1
        result["exitCode"] = self.exit_code
        result = redact(result, self.secrets)
        (self.run_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        self.events.emit("run_finished", result=result)
        self.events.close()
        return result


def run(inspected, command, output=None):
    return Runner(inspected, command, output).run()
