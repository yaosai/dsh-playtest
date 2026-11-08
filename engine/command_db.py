"""Bounded JSON database adapter invocation, not a shell or process platform.

Adapters are trusted project code and direct children in the existing process
range. Each adapter owns and foreground-awaits its children. Hard termination
cannot prove descendant cleanup and is reported conservatively, not as safe.
"""
from __future__ import annotations

import atexit
import json
import os
import selectors
import subprocess
import time

from common import (EngineError, MAX_RESPONSE_BYTES, MAX_ROWS,
                    command_database_assets, is_read_sql, redact, validate_expected_target)

STDERR_LIMIT = 4096
_ACTIVE_ADAPTERS = set()


def _stop_and_wait(process, pending_cancel=False):
    """Reap the direct child; exit 143 attests cooperative subtree teardown.

    This convention is an adapter contract, not a sandbox guarantee. Unhandled
    signals, hard termination, and unconfirmed exit retain uncertainty.
    """
    signalled = False
    forced = False
    if process.poll() is None:
        signalled = True
        try:
            process.terminate()
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            forced = True
            try:
                process.kill()
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                return {"status": "failed", "reason": "Adapter still alive after kill and bounded wait"}
        except OSError:
            if process.poll() is None:
                return {"status": "failed", "reason": "Adapter termination or exit could not be confirmed"}
    code = process.poll()
    if code is None:
        return {"status": "failed", "reason": "Adapter exit could not be confirmed"}
    process.wait()
    if forced:
        return {"status": "unknown", "reason": "Adapter reaped after hard kill; descendant cleanup is unknown"}
    if code == 143 and (signalled or pending_cancel):
        return {"status": "completed", "reason": "Adapter exit 143 attests its cooperative child teardown"}
    if code in (0, 1) and not pending_cancel and not signalled:
        return {"status": "completed", "reason": "Adapter exited naturally and was reaped"}
    return {"status": "unknown", "reason": "Adapter exit " + str(code) + " does not attest descendant cleanup"}


def _exit_cleanup():
    # Emergency best effort only; no result is rewritten to claim successful
    # cleanup during interpreter shutdown. Adapters own their child lifetimes.
    for process in tuple(_ACTIVE_ADAPTERS):
        try:
            _stop_and_wait(process, pending_cancel=True)
        except OSError:
            pass
        if process.poll() is not None:
            _ACTIVE_ADAPTERS.discard(process)


atexit.register(_exit_cleanup)


def _strict_json(raw):
    def nonfinite(_value):
        raise ValueError("non-finite JSON value")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON field")
            result[key] = value
        return result
    try:
        return json.loads(raw.decode("utf-8"), parse_constant=nonfinite, object_pairs_hook=pairs)
    except (UnicodeError, ValueError) as exc:
        raise EngineError("Database adapter must return one strict UTF-8 JSON object; no empty/table output", "adapter_protocol") from exc


def _diagnostic(raw):
    text = str(redact(raw.decode("utf-8", errors="replace")))
    return text.encode("utf-8")[:STDERR_LIMIT].decode("utf-8", errors="ignore")


def _validated_response(raw, returncode, stderr, expected_target):
    if not raw.strip():
        raise EngineError("Database adapter returned empty output", "adapter_protocol")
    response = _strict_json(raw)
    if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
        raise EngineError("Database adapter response requires boolean ok", "adapter_protocol")
    version = response.get("version", 1)
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        raise EngineError("Unsupported database adapter response version", "adapter_protocol")
    if not response["ok"]:
        message = response.get("error")
        code = response.get("code", "database")
        if not isinstance(message, str) or not message.strip() or not isinstance(code, str):
            raise EngineError("Adapter error response requires error text and optional code", "adapter_protocol")
        raise EngineError("Database adapter failed: " + str(redact(message))[:STDERR_LIMIT], code)
    if returncode != 0:
        detail = _diagnostic(stderr).strip()
        raise EngineError("Database adapter exited unsuccessfully (" + str(returncode) + ")" + (": " + detail if detail else ""), "adapter_exit")
    rows = response.get("rows")
    affected = response.get("rowsAffected")
    if not isinstance(rows, list) or len(rows) > MAX_ROWS or any(not isinstance(row, dict) for row in rows):
        raise EngineError("Database adapter rows must be at most 1000 row objects", "adapter_protocol")
    if not isinstance(affected, int) or isinstance(affected, bool) or affected < 0:
        raise EngineError("Database adapter rowsAffected must be a non-negative integer", "adapter_protocol")
    target = response.get("target")
    try:
        validate_expected_target(target)
    except EngineError as exc:
        raise EngineError("Database adapter target is invalid", "adapter_target") from exc
    if json.dumps(target, sort_keys=True) != json.dumps(expected_target, sort_keys=True):
        # Do not echo target contents: a malformed provider may include credentials.
        raise EngineError("Database adapter target does not match expectedTarget", "adapter_target")
    return rows, affected, target


def query(runner, database_name, spec, step):
    """Execute one approved database command with typed input/output and limits."""
    if runner.command.get("allowEffects") is not True:
        raise EngineError("Command database adapters require effects confirmation, including reads", "effects_required")
    runner.checkpoint()
    if os.name != "posix":
        raise EngineError("Command adapter pipe multiplexing currently requires POSIX", "adapter_platform")
    argv, fingerprints = command_database_assets(runner.root, spec)
    frozen = runner.snapshot.get("adapterAssets", {})
    if any(frozen.get(path) != fingerprint for path, fingerprint in fingerprints.items()):
        raise EngineError("Database adapter dependency changed since preview", "stale_adapter")
    params = step.get("params", [])
    if not isinstance(params, list):
        raise EngineError("Command database params must be an array", "adapter_params")
    # Approval permits adapter execution; readOnly remains a separate SQL hint.
    read_only = step.get("readOnly") is True or is_read_sql(step["sql"])
    payload = {"version": 1, "sql": step["sql"], "params": params,
               "readOnly": read_only, "allowWrite": runner.command.get("allowEffects") is True,
               "runDir": str(runner.run_dir), "expectedTarget": spec["expectedTarget"]}
    try:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise EngineError("Database adapter request must be finite JSON", "adapter_protocol") from exc
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise EngineError("Database adapter request exceeds 1 MiB", "adapter_limit")
    runner.checkpoint()
    requested_timeout = float(step.get("timeoutSeconds", 60))
    deadline = time.monotonic() + runner.timeout(requested_timeout)
    process = None
    selector = selectors.DefaultSelector()
    streams = []
    stdout, stderr = bytearray(), bytearray()
    stderr_truncated = False
    try:
        process = subprocess.Popen(argv, cwd=str(runner.root), stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   shell=False, start_new_session=False)
        runner.adapter_processes.add(process)
        _ACTIVE_ADAPTERS.add(process)
        streams = [process.stdin, process.stdout, process.stderr]
        for stream in streams:
            os.set_blocking(stream.fileno(), False)
        selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        position = 0
        root_exit_at = None
        while selector.get_map():
            runner.checkpoint()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise EngineError("Database adapter exceeded the step time limit", "adapter_timeout")
            for key, _mask in selector.select(min(0.05, remaining)):
                stream = key.fileobj
                if key.data == "stdin":
                    try:
                        written = os.write(stream.fileno(), encoded[position:position + 65536])
                        position += written
                    except BlockingIOError:
                        continue
                    except BrokenPipeError as exc:
                        raise EngineError("Database adapter closed stdin before receiving its request", "adapter_protocol") from exc
                    if position == len(encoded):
                        selector.unregister(stream)
                        stream.close()
                else:
                    try:
                        chunk = os.read(stream.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(stream)
                        stream.close()
                    elif key.data == "stdout":
                        stdout.extend(chunk)
                        if len(stdout) > MAX_RESPONSE_BYTES:
                            raise EngineError("Database adapter stdout exceeds 1 MiB", "adapter_limit")
                    else:
                        stderr.extend(chunk)
                        if len(stderr) > STDERR_LIMIT:
                            stderr_truncated = True
                            del stderr[:-STDERR_LIMIT]
            if process.poll() is not None:
                root_exit_at = root_exit_at or time.monotonic()
                # A child retaining the adapter's stdio is observable unfinished
                # work. Do not infer arbitrary descendants from process IDs.
                if selector.get_map() and time.monotonic() - root_exit_at > 0.25:
                    runner.command_children_unsettled = True
                    runner.adapter_cleanup_status = "unknown"
                    raise EngineError("Adapter exited while inherited output pipes remain live", "adapter_processes")
        while process.poll() is None:
            runner.checkpoint()
            if time.monotonic() >= deadline:
                raise EngineError("Database adapter exceeded the step time limit", "adapter_timeout")
            time.sleep(0.01)
        runner.checkpoint()
        rows, affected, target = _validated_response(bytes(stdout), process.returncode, bytes(stderr), spec["expectedTarget"])
        observation = {"database": database_name, "driver": "command", "sql": step["sql"],
                       "params": params, "readOnly": read_only, "rows": rows,
                       "rowsAffected": affected, "target": target,
                       "adapterStderr": _diagnostic(bytes(stderr)),
                       "adapterStderrTruncated": stderr_truncated}
        return rows, observation
    except OSError as exc:
        raise EngineError("Could not execute database adapter: " + str(redact(str(exc))), "adapter_spawn") from exc
    finally:
        selector.close()
        try:
            if process is not None:
                state = _stop_and_wait(process, pending_cancel=runner.cancelled.is_set() and not runner.cleaning)
                if getattr(runner, "command_children_unsettled", False) and state["status"] == "completed":
                    state = {"status": "unknown", "reason": "Adapter exited, but inherited child pipes did not finish"}
                if state["status"] != "completed":
                    runner.command_children_unsettled = True
                    if state["status"] == "failed" or runner.adapter_cleanup_status != "failed":
                        runner.adapter_cleanup_status = state["status"]
                    runner.adapter_cleanup_reasons.append(state["reason"])
                runner.events.emit("adapter_cleanup", play=(runner.item or {}).get("slug"),
                                   database=database_name, status=state["status"], reason=state["reason"])
                if process.poll() is not None:
                    runner.adapter_processes.discard(process)
                    _ACTIVE_ADAPTERS.discard(process)
        except OSError as exc:
            runner.command_children_unsettled = True
            runner.adapter_cleanup_status = "failed"
            runner.adapter_cleanup_reasons.append("Adapter termination failed: " + str(redact(str(exc))))
            raise EngineError("Adapter termination or wait failed", "adapter_processes") from exc
        finally:
            for stream in streams:
                if not stream.closed:
                    stream.close()
