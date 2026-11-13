"""Shared asset compilation, validation, paths, and bounded evidence.

No business defaults, dependencies, or agent logic. Command database adapters
are inspected as repository files only; this module never executes them.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

MAX_ASSET_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_EVIDENCE_CHARS = 4096
MAX_ROWS = 1000
CLEANUP_SECONDS = 30
MAX_CLEANUP_SECONDS = 180
MAX_PLAYS = 32

# The plugin's asset convention, defined once: one directory per repository holds the
# committed plays and the generated evidence, and its own .gitignore excludes the latter.
ASSETS = ".test-plays"
CONFIG = ASSETS + "/config.json"
RUNS = ASSETS + "/runs"
CACHE = ASSETS + "/cache"
# Reserved names inside ASSETS: they are never play slugs.
RESERVED = ("runs", "cache")
LEGACY_ASSETS = "test-plays"
LEGACY_CONFIG = ".playtest.json"
LEGACY_RUNS = ".playtest"
SECRET_KEY = re.compile(r"authorization|cookie|password|passwd|token|secret|api[-_]?key|credential", re.I)
VARIABLE = re.compile(r"\$\{([^{}]+)\}")
MISSING = object()


class EngineError(Exception):
    def __init__(self, message, code="configuration"):
        super().__init__(message)
        self.code = code


def repository(path):
    if not isinstance(path, str) or not path:
        raise EngineError("repoRoot must name an existing repository directory")
    root = Path(path).expanduser().resolve()
    if not root.is_dir():
        raise EngineError("repoRoot does not exist or is not a directory")
    # One enforcement point: every action resolves the repository through here, so the
    # old layout is refused with instructions instead of reporting "no plays found".
    require_layout(root)
    return root


def safe_path(root, value, base=None, must_exist=False):
    if not isinstance(value, str) or not value or "\x00" in value:
        raise EngineError("Path must be a non-empty string", "path_restriction")
    root = Path(root).resolve()
    raw = Path(value)
    path = (raw if raw.is_absolute() else Path(base or root) / raw).resolve()
    if not path.is_relative_to(root):
        raise EngineError("Path escapes repository: " + str(value), "path_restriction")
    if must_exist and not path.is_file():
        raise EngineError("Asset file not found: " + str(value), "missing_asset")
    return path


def read_json(path):
    try:
        if path.stat().st_size > MAX_ASSET_BYTES:
            raise EngineError("Asset exceeds 4 MiB: " + str(path))
        value = json.loads(path.read_text(encoding="utf-8"))
    except EngineError:
        raise
    except (OSError, UnicodeError, ValueError) as exc:
        raise EngineError("Cannot read JSON asset " + str(path) + ": " + str(exc)) from exc
    if not isinstance(value, dict):
        raise EngineError("JSON asset must be an object: " + str(path))
    return value


def origin(url):
    if not isinstance(url, str):
        raise EngineError("HTTP URL must be a string", "origin_restriction")
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise EngineError("HTTP URL requires http(s) and a host", "origin_restriction")
    if parts.username is not None or parts.password is not None:
        raise EngineError("Credentials in URLs are not supported; use headers", "origin_restriction")
    try:
        port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise EngineError("Invalid HTTP port", "origin_restriction") from exc
    return (parts.scheme.lower(), parts.hostname.lower(), port)


def secret_values(value):
    values = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if SECRET_KEY.search(str(key)) and isinstance(item, str) and item:
                values.add(item)
                if item.lower().startswith("bearer "):
                    values.add(item[7:])
            values.update(secret_values(item))
    elif isinstance(value, list):
        for item in value:
            values.update(secret_values(item))
    return values


def redact(value, secrets=None):
    secrets = secret_values(value) if secrets is None else secrets
    if isinstance(value, dict):
        return {str(k): "[REDACTED]" if SECRET_KEY.search(str(k)) else redact(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, secrets) for v in value]
    if isinstance(value, str):
        # Referenced JSON contents are still strings in the source snapshot.
        try:
            decoded = json.loads(value)
        except ValueError:
            decoded = None
        if isinstance(decoded, (dict, list)):
            return json.dumps(redact(decoded, secrets), ensure_ascii=False)
        text = re.sub(r"(?i)\bBearer\s+[^\s\"']+", "Bearer [REDACTED]", value)
        for secret in sorted(secrets, key=len, reverse=True):
            if len(secret) >= 3:
                text = text.replace(secret, "[REDACTED]")
        text = re.sub(r"(?i)(password|passwd|token|secret|api[-_]?key)(\s*[=:]\s*)([^\s&,;\"']+)", r"\1\2[REDACTED]", text)
        if text.startswith(("http://", "https://")):
            try:
                p = urlsplit(text)
                query = [(k, "[REDACTED]" if SECRET_KEY.search(k) else v) for k, v in parse_qsl(p.query, keep_blank_values=True)]
                netloc = p.netloc.rsplit("@", 1)[-1]
                text = urlunsplit((p.scheme, netloc, p.path, urlencode(query), p.fragment))
            except ValueError:
                pass
        return text
    return value


def evidence(value):
    """Bound only displayed evidence, never the input used for assertions."""
    clean = redact(value)
    text = json.dumps(clean, ensure_ascii=False, default=str)
    if len(text) > MAX_EVIDENCE_CHARS:
        return {"text": text[:MAX_EVIDENCE_CHARS], "truncated": True}
    return {"data": clean, "truncated": False}


def substitute(value, variables):
    def get(name):
        if name in variables:
            return copy.deepcopy(variables[name])
        current = variables
        for component in name.split("."):
            if not isinstance(current, dict) or component not in current:
                raise EngineError("Missing variable: " + name, "missing_variable")
            current = current[component]
        return copy.deepcopy(current)
    if isinstance(value, str):
        match = VARIABLE.fullmatch(value)
        if match:
            return get(match.group(1))
        def replace(match):
            result = get(match.group(1))
            return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        return VARIABLE.sub(replace, value)
    if isinstance(value, list):
        return [substitute(v, variables) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, variables) for k, v in value.items()}
    return value


def json_path(value, expression):
    if not isinstance(expression, str) or not expression.startswith("$"):
        raise EngineError("JSON path must start with $", "invalid_json_path")
    tail = expression[1:]
    tokens = []
    while tail:
        match = re.match(r"^(?:\.([A-Za-z_][\w-]*)|\[(\d+|\*)\]|\[['\"]([^'\"]+)['\"]\])", tail)
        if not match:
            raise EngineError("Unsupported JSON path: " + expression, "invalid_json_path")
        tokens.append(match.group(1) or match.group(2) or match.group(3))
        tail = tail[match.end():]
    wildcard = "*" in tokens
    current = [value]
    for token in tokens:
        following = []
        for item in current:
            if token == "*" and isinstance(item, list):
                following.extend(item)
            elif isinstance(item, dict) and token in item:
                following.append(item[token])
            elif isinstance(item, list) and token.isdigit() and int(token) < len(item):
                following.append(item[int(token)])
        current = following
    if not current:
        return [] if wildcard else MISSING
    return current if wildcard else current[0]


def equal(actual, expected):
    if actual is MISSING:
        return False
    # bool is not an integer in JSON assertions despite Python's subclassing.
    if isinstance(actual, bool) != isinstance(expected, bool):
        return False
    return actual == expected


def assertion_count(step):
    if step.get("type", "http") == "mockVerify":
        return 1
    expectation = step.get("expect") or {}
    if not isinstance(expectation, dict):
        return 0
    if step.get("type", "http") == "http":
        json_expect = expectation.get("json") or {}
        return int("status" in expectation) + (len(json_expect) if isinstance(json_expect, dict) else 0)
    return len(expectation) if step.get("type") in ("dbQuery", "dbWait") else 0


CHECK_TYPES = ("dbQuery", "dbWait", "mockVerify")
MAX_CHECKS_PER_STEP = 32


def check_list(step):
    checks = step.get("checks")
    return checks if isinstance(checks, list) else []


def total_assertion_count(step):
    """Assertions belonging to one business step, including its verifications."""
    return assertion_count(step) + sum(assertion_count(c) for c in check_list(step) if isinstance(c, dict))


def is_read_sql(sql):
    sql = re.sub(r"/\*.*?\*/|--[^\n]*", " ", str(sql), flags=re.S).strip()
    return bool(re.match(r"(?is)^SELECT\b", sql))


def selected_paths(root, request, discover=False):
    require_layout(root)
    plays_root = safe_path(root, ASSETS)
    selected = request.get("plays")
    if selected is None:
        selected = [request["play"]] if request.get("play") else None
    if selected is None and discover:
        found = [p for p in sorted(plays_root.glob("*/play.json")) if p.parent.name not in RESERVED]
        return [safe_path(root, str(p), must_exist=True) for p in found] if plays_root.is_dir() else []
    if not isinstance(selected, list) or not selected or len(selected) > MAX_PLAYS:
        raise EngineError("Select play or a non-empty plays list (maximum 32)")
    paths = []
    for item in selected:
        if not isinstance(item, str) or not item:
            raise EngineError("Play selections must be strings")
        if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", item):
            path = safe_path(root, str(plays_root / item / "play.json"), must_exist=True)
        else:
            path = safe_path(root, item, must_exist=True)
        if not path.is_relative_to(plays_root):
            raise EngineError("Selected play must be inside " + ASSETS, "path_restriction")
        if path in paths:
            raise EngineError("Duplicate play selection")
        paths.append(path)
    return paths


ASSET_IGNORE = "/runs/\n/cache/\n"


def ensure_assets_ignore(root):
    """Keep generated evidence out of git without touching the repository's own .gitignore.

    Written whenever the plugin creates assets, so a fresh clone needs no setup step and
    `git status` stays clean after a playback.
    """
    directory = safe_path(root, ASSETS)
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / ".gitignore"
    if not marker.exists():
        marker.write_text("# 播放生成的运行证据与缓存：每次播放都变，不入库。\n" + ASSET_IGNORE, encoding="utf-8")
    return directory


def require_layout(root):
    """Point at the old layout instead of reporting an empty repository."""
    if (root / ASSETS).is_dir():
        return
    found = [str((root / name).relative_to(root)) for name in (LEGACY_ASSETS, LEGACY_CONFIG, LEGACY_RUNS)
             if (root / name).exists()]
    if found:
        raise EngineError(
            "Found the pre-1.9 layout: " + ", ".join(found) + ". This plugin reads one directory only: "
            + ASSETS + "/ containing config.json, <slug>/play.json and runs/. "
            "Move them (git mv " + LEGACY_ASSETS + " " + ASSETS + "; "
            + LEGACY_CONFIG + " -> " + CONFIG + "; " + LEGACY_RUNS + "/runs -> " + RUNS + ") "
            "and add " + ASSETS + "/.gitignore with /runs/ and /cache/.", "legacy_layout")


def issue(level, code, message, path=None):
    record = {"level": level, "code": code, "message": message}
    if path:
        record["path"] = str(path)
    return record


def validate_steps(steps, path, phase, allow_variables=True):
    def deferred(value):
        return allow_variables and isinstance(value, str) and VARIABLE.fullmatch(value) is not None
    issues = []
    if not isinstance(steps, list):
        return [issue("error", "steps", phase + " steps must be an array", path)]
    if len(steps) > 256:
        issues.append(issue("error", "step_limit", "Each phase supports at most 256 steps", path))
    numbers = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            issues.append(issue("error", "step", "Each step must be an object", path))
            continue
        number = step.get("stepNo", index + 1)
        if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
            issues.append(issue("error", "step_no", "stepNo must be a positive integer", path))
        else:
            numbers.append(number)
        if "expectFailure" in step:
            issues.append(issue("error", "legacy_expect_failure", "expectFailure is unsupported: use explicit expect.status and expect.json for the intended refusal", path))
        kind = step.get("type", "http")
        if kind not in ("http", "dbQuery", "dbWait", "wait", "mockVerify"):
            issues.append(issue("error", "step_type", "Unsupported step type: " + str(kind), path))
            continue
        expectation = step.get("expect", {})
        if not isinstance(expectation, dict):
            issues.append(issue("error", "expect", "expect must be an object", path))
            continue
        if total_assertion_count(step) > 64:
            issues.append(issue("error", "assertion_limit", "Each step supports at most 64 assertions", path))
        checks = step.get("checks")
        if checks is not None:
            if not isinstance(checks, list) or not checks:
                issues.append(issue("error", "checks", "checks must be a non-empty array of verifications", path))
            elif len(checks) > MAX_CHECKS_PER_STEP:
                issues.append(issue("error", "checks_limit", "A step supports at most 32 checks", path))
            else:
                for check in checks:
                    if not isinstance(check, dict):
                        issues.append(issue("error", "check", "Each check must be an object", path))
                        continue
                    if "checks" in check:
                        issues.append(issue("error", "checks_nested", "checks cannot nest", path))
                        continue
                    if check.get("type") not in CHECK_TYPES:
                        issues.append(issue("error", "check_type",
                                            "A check must be dbQuery, dbWait or mockVerify; use a step for actions", path))
                        continue
                    issues.extend(validate_steps([{key: value for key, value in check.items() if key != "checks"}],
                                                 path, phase, allow_variables))
        if kind == "http":
            if not isinstance(step.get("path"), str) or not step["path"]:
                issues.append(issue("error", "http_path", "HTTP path is required", path))
            if str(step.get("method", "GET")).upper() not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
                issues.append(issue("error", "http_method", "Unsupported HTTP method", path))
            if not isinstance(step.get("headers", {}), dict):
                issues.append(issue("error", "headers", "headers must be an object", path))
            if set(expectation) - {"status", "json"}:
                issues.append(issue("error", "http_expect", "HTTP expect supports status and json only", path))
            status = expectation.get("status", 200)
            statuses = status if isinstance(status, list) else [status]
            if "status" in expectation and not deferred(status) and (not statuses or any(not isinstance(v, int) or isinstance(v, bool) or not 100 <= v <= 599 for v in statuses)):
                issues.append(issue("error", "http_status", "expect.status must be a status integer or non-empty status list", path))
            if not isinstance(expectation.get("json", {}), dict):
                issues.append(issue("error", "http_json", "expect.json must map JSON paths to expected values", path))
            else:
                for expression in expectation.get("json", {}):
                    try:
                        json_path({}, expression)
                    except EngineError as exc:
                        issues.append(issue("error", exc.code, str(exc), path))
            extracts = step.get("extractFromResponse", {})
            if not isinstance(extracts, dict):
                issues.append(issue("error", "extract", "extractFromResponse must be an object", path))
            else:
                for expression in extracts.values():
                    try:
                        json_path({}, expression)
                    except EngineError as exc:
                        issues.append(issue("error", exc.code, str(exc), path))
        elif kind in ("dbQuery", "dbWait"):
            if not isinstance(step.get("sql"), str) or not step["sql"].strip():
                issues.append(issue("error", "sql", "SQL text or sqlFile is required", path))
            if not isinstance(step.get("params", []), (list, dict)) and not deferred(step.get("params")):
                issues.append(issue("error", "sql_params", "SQL params must be an array or object", path))
            if kind == "dbWait" and not expectation and not (isinstance(step.get("extract"), dict) and step.get("extract")):
                # Waiting for a row to exist (extract) is a condition; waiting with
                # neither an expectation nor an extraction would be a no-op.
                issues.append(issue("error", "db_wait_expect",
                                    "dbWait needs a non-empty expect, or extract to wait for the row itself", path))
            if not isinstance(step.get("extract", {}), dict):
                issues.append(issue("error", "extract", "extract must map variable names to columns", path))
            if "readOnly" in step and not deferred(step["readOnly"]) and not isinstance(step["readOnly"], bool):
                issues.append(issue("error", "read_only", "readOnly must be a boolean", path))
        elif kind == "wait":
            seconds = step.get("seconds")
            if not deferred(seconds) and (not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not 0 <= seconds <= 3600):
                issues.append(issue("error", "wait", "wait.seconds must be between 0 and 3600", path))
        elif kind == "mockVerify":
            count = step.get("count")
            if not isinstance(step.get("mock"), str) or (not deferred(count) and (not isinstance(count, int) or isinstance(count, bool) or count < 0)):
                issues.append(issue("error", "mock_verify", "mockVerify needs mock id and non-negative count", path))
        for field, default in (("httpTimeoutSeconds", 15), ("timeoutSeconds", 60), ("intervalSeconds", 1)):
            value = step.get(field, default)
            if not deferred(value) and (not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 < value <= 3600):
                issues.append(issue("error", "timeout", field + " must be positive and at most 3600", path))
    if len(numbers) != len(set(numbers)) or numbers != sorted(numbers):
        issues.append(issue("error", "step_order", phase + " stepNo must be unique and ascending", path))
    return issues


def resolve_files(root, steps, directory, assets):
    if not isinstance(steps, list):
        return steps
    result = copy.deepcopy(steps)
    for step in result:
        if not isinstance(step, dict):
            continue
        for source, destination in (("sqlFile", "sql"), ("bodyFile", "body")):
            if source not in step:
                continue
            if destination in step:
                raise EngineError("Specify either " + source + " or " + destination + ", not both")
            path = safe_path(root, step[source], base=directory, must_exist=True)
            if path.stat().st_size > MAX_ASSET_BYTES:
                raise EngineError("Referenced file exceeds 4 MiB")
            text = path.read_text(encoding="utf-8")
            assets[str(path.relative_to(root))] = text
            try:
                step[destination] = json.loads(text) if destination == "body" else text
            except ValueError as exc:
                raise EngineError("bodyFile must contain JSON") from exc
            del step[source]
    return result


def file_fingerprint(root, value):
    """Hash a regular repository dependency without retaining private contents."""
    path = safe_path(root, value, must_exist=True)
    before = path.stat()
    if before.st_size > MAX_ASSET_BYTES:
        raise EngineError("Adapter dependency exceeds 4 MiB: " + str(value), "asset_limit")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            digest.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise EngineError("Adapter dependency changed while inspecting", "stale_adapter")
    return str(path.relative_to(Path(root).resolve())), {"sha256": digest.hexdigest(), "bytes": after.st_size}


def validate_expected_target(target):
    if not isinstance(target, dict) or not target:
        raise EngineError("Command database expectedTarget must be an object", "adapter_target")
    if not isinstance(target.get("host"), str) or not target["host"].strip():
        raise EngineError("expectedTarget.host is required", "adapter_target")
    if not isinstance(target.get("database"), str) or not target["database"].strip():
        raise EngineError("expectedTarget.database is required", "adapter_target")
    port = target.get("port")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise EngineError("expectedTarget.port must be 1..65535", "adapter_target")
    if any(SECRET_KEY.search(str(key)) for key in target):
        raise EngineError("Target fingerprints cannot contain credentials", "adapter_target")
    try:
        json.dumps(target, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise EngineError("expectedTarget must be finite JSON", "adapter_target") from exc


def command_database_assets(root, database):
    """Validate command argv and return canonical argv plus dependency hashes.

    No PATH lookup, executable launch, configuration decryption, or DB connection
    occurs here. Interpreter code strings and shell entry points are not adapters.
    """
    argv = database.get("argv")
    if not isinstance(argv, list) or not argv or len(argv) > 64 or any(
            not isinstance(arg, str) or not arg or "\x00" in arg or VARIABLE.search(arg) for arg in argv):
        raise EngineError("Command database argv must be 1..64 non-empty literal strings", "adapter_argv")
    program = argv[0].replace("\\", "/").rsplit("/", 1)[-1].lower()
    shell_names = {"sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh",
                   "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"}
    if program in shell_names or any(arg.lower() in ("-c", "--command", "/c", "/k", "-command", "-encodedcommand", "-e", "--eval") for arg in argv[1:]):
        raise EngineError("Command database adapters cannot use a shell or inline code", "adapter_argv")
    declared = database.get("assetFiles")
    if not isinstance(declared, list) or not declared or len(declared) > 128 or any(not isinstance(v, str) for v in declared):
        raise EngineError("Command database assetFiles must declare repository dependencies", "adapter_assets")
    validate_expected_target(database.get("expectedTarget"))
    normalized = []
    files = list(declared)
    executable_asset = False
    suffixes = (".py", ".js", ".mjs", ".cjs", ".jar", ".json", ".yaml", ".yml", ".sql", ".sh", ".exe")
    for index, argument in enumerate(argv):
        prefix, candidate = "", argument
        if index and argument.startswith("-") and "=" in argument:
            prefix, candidate = argument.split("=", 1)
            prefix += "="
        if index and candidate.startswith("-"):
            normalized.append(argument)
            continue
        has_separator = "/" in candidate or "\\" in candidate
        if "\\" in candidate:
            # The executing filesystem owns path semantics; don't treat a Windows
            # absolute path as a harmless basename on POSIX.
            import os
            if os.name != "nt":
                raise EngineError("Backslash command paths are unsupported on this host", "path_restriction")
        existing = (Path(root) / candidate).exists() if not Path(candidate).is_absolute() else Path(candidate).exists()
        looks_like_file = has_separator or existing or (index > 0 and candidate.lower().endswith(suffixes))
        if looks_like_file:
            path = safe_path(root, candidate, must_exist=True)
            files.append(str(path))
            normalized.append(prefix + str(path))
            executable_asset = executable_asset or index == 0 or not prefix
        else:
            if index == 0 and not re.fullmatch(r"[A-Za-z0-9_.+-]+", candidate):
                raise EngineError("Executable must be a bare PATH name or repository path", "adapter_argv")
            normalized.append(argument)
    if not executable_asset:
        raise EngineError("Command adapters must execute a repository program or script file", "adapter_argv")
    fingerprints = {}
    for filename in files:
        key, fingerprint = file_fingerprint(root, filename)
        fingerprints[key] = fingerprint
    return normalized, fingerprints


def cleanup_budget(play, scenario):
    """Seconds allowed for this play's cleanup phase; JVM-based adapters need more."""
    for source in (play, scenario):
        if not isinstance(source, dict) or source.get("cleanupSeconds") is None:
            continue
        value = source["cleanupSeconds"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 1 <= value <= MAX_CLEANUP_SECONDS:
            raise EngineError("cleanupSeconds must be a number between 1 and 180", "invalid_step")
        return float(value)
    return float(CLEANUP_SECONDS)


# Headers the transport owns: accepting them here would produce requests that look
# valid in the asset but fail or misroute on the wire.
RESERVED_TARGET_HEADERS = ("host", "content-length", "connection", "transfer-encoding", "expect")


def target_headers(config, target):
    """Authentication and other environment-level headers, declared once per target.

    A token belongs to "which service am I talking to", not to each test's data: keeping it
    in the target means three scenarios of one play cannot drift apart or leak it into play
    files. Step-level headers still win, so a test can override or add its own.
    """
    spec = config.get("targets", {}).get(target) if isinstance(target, str) else None
    declared = (spec or {}).get("headers") if isinstance(spec, dict) else None
    if declared is None:
        return {}
    if not isinstance(declared, dict):
        raise EngineError("Target " + str(target) + " headers must be an object", "invalid_target_header")
    merged = {}
    for name, value in declared.items():
        if str(name).lower() in RESERVED_TARGET_HEADERS:
            raise EngineError("Target header " + str(name) + " is owned by the transport", "invalid_target_header")
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise EngineError("Target header " + str(name) + " must be a scalar", "invalid_target_header")
        merged[str(name)] = value
    return merged


def origin_of(url):
    """scheme://host:port of a URL, or None when it is not an absolute URL."""
    match = re.match(r"^(https?://[^/?#]+)", str(url or ""), re.I)
    return match.group(1).rstrip("/").lower() if match else None


def merge_headers(step, declared):
    """Environment headers first, the step's own value on top."""
    if not declared:
        return step.get("headers") or {}
    step_headers = step.get("headers") or {}
    if not isinstance(step_headers, dict):
        return declared
    return {**declared, **step_headers}


def resolve_prepare(root, config, steps, config_path):
    """Copy project preparation checks and resolve each target name to its base URL."""
    resolved = []
    for index, step in enumerate(steps or []):
        if not isinstance(step, dict):
            continue
        copy = dict(step)
        copy.setdefault("stepNo", index + 1)
        target = copy.get("target")
        if target:
            spec = config.get("targets", {}).get(target)
            if not isinstance(spec, dict) or not isinstance(spec.get("baseUrl"), str):
                raise EngineError("Unknown or invalid prepare target: " + str(target), "unknown_target")
            copy["baseUrl"] = spec["baseUrl"]
            copy["headers"] = merge_headers(copy, target_headers(config, target))
        resolved.append(copy)
    return resolved


def compile_prepare(root, config, config_path, assets):
    """Project-provided scenario preparation: read-only readiness checks run before any play.

    The plugin never invents what "ready" means; the repository declares it here
    (for example the service answers health, the database is reachable).
    """
    steps = config.get("prepare")
    if steps is None:
        return [], [], []
    if not isinstance(steps, list):
        return [], [issue("error", "prepare", "prepare must be an array of readiness steps", config_path)], []
    steps = resolve_files(root, steps, root, assets)
    issues = []
    for index, step in enumerate(steps):
        position = index + 1
        if not isinstance(step, dict):
            continue
        kind = step.get("type", "http")
        if kind not in ("http", "dbQuery", "dbWait"):
            issues.append(issue("error", "prepare_type",
                                "prepare 只允许 http、dbQuery、dbWait 就绪检查；造数请写在场景 setup", config_path))
            continue
        if kind == "http":
            if str(step.get("method", "GET")).upper() not in ("GET", "HEAD", "OPTIONS"):
                issues.append(issue("error", "prepare_method",
                                    "prepare 的 HTTP 只允许只读方法（GET/HEAD/OPTIONS）", config_path))
            if "body" in step:
                issues.append(issue("error", "prepare_body", "prepare 不允许请求体", config_path))
            if not step.get("target") and not step.get("baseUrl") and not step.get("path", "").startswith("${mock."):
                issues.append(issue("error", "prepare_target", "prepare 的 HTTP 检查必须指定 target 或 baseUrl", config_path))
        else:
            if step.get("readOnly") is False or not is_read_sql(step.get("sql", "")):
                issues.append(issue("error", "prepare_readonly",
                                    "prepare 的数据库检查必须是只读 SELECT；写数据属于场景 setup", config_path))
        if not (step.get("expect") or {}):
            issues.append(issue("error", "prepare_expect",
                                "prepare 检查必须声明 expect，否则无法证明环境已就绪", config_path))
        step["stepNo"] = step.get("stepNo", position)
    return steps, issues, []


def compile_request(request, discover=False):
    root = repository(request.get("repoRoot"))
    config_path = safe_path(root, CONFIG)
    config = read_json(config_path) if config_path.is_file() else {}
    if not isinstance(config.get("targets", {}), dict) or not isinstance(config.get("databases", {}), dict):
        raise EngineError("targets and databases must be objects")
    adapter_assets = {}
    for name, database in config.get("databases", {}).items():
        if not isinstance(database, dict):
            raise EngineError("Database " + str(name) + " must be an object")
        if database.get("driver") == "command":
            _argv, fingerprints = command_database_assets(root, database)
            adapter_assets.update(fingerprints)
        elif database.get("driver") == "sqlite" and isinstance(database.get("path"), str):
            sample = substitute(database["path"], {"runId": "preview-run", "runDir": str(root / RUNS / "preview-run")})
            safe_path(root, sample)
        else:
            raise EngineError("Database " + str(name) + " requires driver sqlite or command")
    assets = {}
    if config_path.is_file():
        assets[CONFIG] = config_path.read_text(encoding="utf-8")
    selections = selected_paths(root, request, discover=discover)
    if not selections:
        raise EngineError("No play.json assets found in " + ASSETS, "no_plays")
    compiled, issues, effects, previews = [], [], [], []
    # Scenario preparation is repository-level: the project says what "ready" means.
    prepare_steps, prepare_issues, prepare_effects = compile_prepare(root, config, config_path, assets)
    issues.extend(prepare_issues)
    effects.extend(prepare_effects)
    for path in selections:
        play = read_json(path)
        assets[str(path.relative_to(root))] = path.read_text(encoding="utf-8")
        scenario_selection = request.get("scenario") or play.get("scenario")
        scenario_path = safe_path(root, scenario_selection, base=path.parent, must_exist=True) if scenario_selection else safe_path(root, "scenario.json", base=path.parent)
        if not scenario_path.is_relative_to(path.parent):
            raise EngineError("Scenario must be in the selected play directory", "path_restriction")
        scenario = read_json(scenario_path) if scenario_path.is_file() else {}
        if scenario_path.is_file():
            assets[str(scenario_path.relative_to(root))] = scenario_path.read_text(encoding="utf-8")
        slug = path.parent.name
        if play.get("version") != 1:
            issues.append(issue("error", "version", "play.version must be 1; migrate legacy assets", path))
        if not isinstance(play.get("scenarioName"), str) or not play.get("scenarioName", "").strip():
            issues.append(issue("error", "scenario_name", "scenarioName is required", path))
        mode = play.get("mode", "explore")
        if mode not in ("explore", "baseline", "acceptance"):
            issues.append(issue("error", "mode", "mode must be explore, baseline, or acceptance", path))
        if not isinstance(play.get("claims", []), list):
            issues.append(issue("error", "claims", "claims must be an array", path))
        if not isinstance(scenario.get("variables", {}), dict):
            issues.append(issue("error", "variables", "scenario.variables must be an object", scenario_path))
        try:
            budget = cleanup_budget(play, scenario)
        except EngineError as exc:
            issues.append(issue("error", "cleanup_seconds", str(exc), path))
            budget = float(CLEANUP_SECONDS)
        target = request.get("target") or play.get("target") or scenario.get("target")
        base_url = play.get("baseUrl") or scenario.get("baseUrl")
        if target:
            target_config = config.get("targets", {}).get(target)
            if not isinstance(target_config, dict) or not isinstance(target_config.get("baseUrl"), str):
                raise EngineError("Unknown or invalid target: " + str(target), "unknown_target")
            base_url = target_config["baseUrl"]
        if base_url:
            origin(base_url)
        play_cleanup = resolve_files(root, play.get("cleanup", []), path.parent, assets)
        scenario_cleanup = resolve_files(root, scenario.get("cleanup", []), path.parent, assets)
        issues.extend(validate_steps(play_cleanup, path, "play.cleanup"))
        issues.extend(validate_steps(scenario_cleanup, scenario_path, "scenario.cleanup"))
        cleanup = [{**step, "stepNo": index + 1} if isinstance(step, dict) else step
                   for index, step in enumerate(play_cleanup + scenario_cleanup)] if isinstance(play_cleanup, list) and isinstance(scenario_cleanup, list) else None
        phases = {
            "prepare": resolve_prepare(root, config, prepare_steps, config_path),
            "setup": resolve_files(root, scenario.get("setup", []), path.parent, assets),
            "play": resolve_files(root, play.get("steps"), path.parent, assets),
            "cleanup": cleanup,
        }
        for phase, steps in phases.items():
            issues.extend(validate_steps(steps, path, phase))
        mocks = scenario.get("mocks", [])
        if not isinstance(mocks, list):
            issues.append(issue("error", "mocks", "scenario.mocks must be an array", scenario_path))
            mocks = []
        ids = set()
        for mock in mocks:
            if not isinstance(mock, dict) or not re.fullmatch(r"[A-Za-z0-9_-]+", str(mock.get("id", ""))):
                issues.append(issue("error", "mock_id", "Each mock requires an alphanumeric id", scenario_path))
                continue
            if mock["id"] in ids:
                issues.append(issue("error", "mock_id", "Mock ids must be unique", scenario_path))
            ids.add(mock["id"])
            port = mock.get("port", 0)
            if not isinstance(port, int) or isinstance(port, bool) or not 0 <= port <= 65535:
                issues.append(issue("error", "mock_port", "mock.port must be 0..65535", scenario_path))
            routes = mock.get("routes", [])
            if not isinstance(routes, list):
                issues.append(issue("error", "mock_routes", "Mock routes must be an array", scenario_path))
                continue
            for route in routes:
                if not isinstance(route, dict) or not str(route.get("path", "")).startswith("/") or not isinstance(route.get("status", 200), int) or not 100 <= route.get("status", 200) <= 599:
                    issues.append(issue("error", "mock_route", "Mock route requires /path and HTTP status", scenario_path))
        total_assertions = play_assertions = 0
        # Preparation proves the environment is up; it never makes a business claim,
        # so it stays out of the assertion total and the no-assertions warning.
        for phase, steps in phases.items():
            for step in steps or []:
                if not isinstance(step, dict):
                    continue
                if phase == "play":
                    play_assertions += total_assertion_count(step)
                if phase != "prepare":
                    total_assertions += total_assertion_count(step)
                kind = step.get("type", "http")
                if kind == "http":
                    url = step.get("path", "")
                    match = re.match(r"^\$\{mock\.([A-Za-z0-9_-]+)\.url\}(?:/|$)", str(url))
                    own_mock = bool(match and match.group(1) in ids)
                    step_base = step.get("baseUrl") if isinstance(step.get("baseUrl"), str) else base_url
                    if not own_mock and not step_base and not str(url).startswith(("http://", "https://")):
                        issues.append(issue("error", "http_target", "HTTP path needs explicit target/baseUrl or a mock URL", path))
                    if not own_mock:
                        effects.append({"kind": "http", "code": "http.external", "play": slug, "phase": phase, "stepNo": step.get("stepNo"), "target": step.get("target") or target or step_base or url, "description": "HTTP request to a non-owned service", "requiresConfirmation": True})
                    # Credentials only travel to the origin they belong to: a step with its own
                    # absolute URL, or one pointed at its own mock, must not pick up the target's
                    # Authorization token.
                    step_target = step.get("target") or target
                    # A step's own absolute URL wins over the base, so compare against the URL
                    # that will actually be requested, not just the configured base.
                    effective = url if str(url).startswith(("http://", "https://")) else (
                        (str(step_base).rstrip("/") + url) if step_base and str(url).startswith("/") else step_base)
                    if not own_mock and step_target and effective:
                        declared_base = (config.get("targets", {}).get(step_target) or {}).get("baseUrl")
                        if origin_of(effective) == origin_of(declared_base):
                            declared_headers = target_headers(config, step_target)
                            if declared_headers:
                                step["headers"] = merge_headers(step, declared_headers)
                elif kind in ("dbQuery", "dbWait"):
                    name = step.get("database", "main")
                    database = config.get("databases", {}).get(name)
                    if not database:
                        issues.append(issue("error", "database", "Unknown database: " + str(name), path))
                        continue
                    if database.get("driver") == "command":
                        parameters = step.get("params", [])
                        if not isinstance(parameters, list) and not (isinstance(parameters, str) and VARIABLE.fullmatch(parameters)):
                            issues.append(issue("error", "adapter_params", "Command database params must be an array", path))
                        effects.append({"kind": "database", "code": "database.command", "play": slug, "phase": phase,
                                        "stepNo": step.get("stepNo"), "target": database["expectedTarget"],
                                        "description": "Trusted command adapter invocation (including reads); no connection during preview",
                                        "requiresConfirmation": True})
                    elif not is_read_sql(step.get("sql", "")):
                        sample = substitute(database["path"], {"runId": "preview-run", "runDir": str(root / RUNS / "preview-run")})
                        dbpath = safe_path(root, sample)
                        own_run = dbpath.is_relative_to(root / RUNS / "preview-run")
                        effects.append({"kind": "database", "code": "database.write", "play": slug, "phase": phase, "stepNo": step.get("stepNo"), "target": database["path"], "description": "SQLite write or SQL with unknown effects", "requiresConfirmation": not own_run})
        if not play_assertions:
            # The verdict only reads play-phase assertions, so setup assertions
            # cannot make an unverified play look verified.
            issues.append(issue("warning", "no_assertions",
                                "No assertions in the business steps: run will be inconclusive, not passed", path))
        if mode == "acceptance" and not play.get("claims"):
            issues.append(issue("warning", "no_claims", "Acceptance claims/basis not supplied; engine verifies explicit assertions only", path))
        item = {"slug": slug, "path": str(path.relative_to(root)), "play": play, "scenarioPath": str(scenario_path.relative_to(root)) if scenario_path.is_file() else None, "scenario": scenario, "target": target, "baseUrl": base_url, "phases": phases, "mocks": mocks, "cleanupSeconds": budget}
        compiled.append(item)
        previews.append({"slug": slug, "name": play.get("scenarioName", slug), "description": play.get("description", ""), "mode": mode, "path": item["path"], "scenario": item["scenarioPath"], "target": target, "baseUrl": base_url, "claims": play.get("claims", []), **{phase if phase != "play" else "steps": [{"stepNo": s.get("stepNo", i + 1), "name": s.get("name", ""), "type": s.get("type", "http"), "assertions": total_assertion_count(s),
                                     "checks": [{"name": c.get("name", ""), "type": c.get("type"),
                                                 "assertions": assertion_count(c)} for c in check_list(s) if isinstance(c, dict)]} for i, s in enumerate(steps or []) if isinstance(s, dict)] for phase, steps in phases.items()}, "mocks": [{"id": m.get("id"), "port": m.get("port", 0), "routes": [{"method": r.get("method", "GET"), "path": r.get("path"), "status": r.get("status", 200)} for r in m.get("routes", []) if isinstance(r, dict)]} for m in mocks if isinstance(m, dict)]})
    # Dependencies declared private by command adapters are hash-only, even if
    # an asset happens to be referenced elsewhere in the source inventory.
    for dependency in adapter_assets:
        assets.pop(dependency, None)
    snapshot = {"version": 1, "repoRoot": str(root), "config": config, "plays": compiled,
                "assets": assets, "adapterAssets": adapter_assets}
    digest = hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"ok": not any(i["level"] == "error" for i in issues), "digest": digest, "requiresConfirmation": any(e["requiresConfirmation"] for e in effects), "effects": redact(effects), "issues": issues, "preview": redact({"repoRoot": str(root), "plays": previews,
                             "prepare": [{"stepNo": step.get("stepNo"), "name": step.get("name", ""),
                                          "type": step.get("type", "http"),
                                          "target": step.get("target") or step.get("baseUrl") or "",
                                          "assertions": total_assertion_count(step)}
                                         for step in (compiled[0]["phases"]["prepare"] if compiled else []) if isinstance(step, dict)],
                             "assertions": sum(sum(s["assertions"] for s in p["steps"] + p["setup"] + p["cleanup"]) for p in previews),
                             "prepareAssertions": sum(total_assertion_count(step) for step in prepare_steps if isinstance(step, dict)), "effects": effects, "limits": {"maxResponseBytes": MAX_RESPONSE_BYTES, "maxEvidenceChars": MAX_EVIDENCE_CHARS, "maxRows": MAX_ROWS, "cleanupSeconds": CLEANUP_SECONDS}}), "snapshot": snapshot}
