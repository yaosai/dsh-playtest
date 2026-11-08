"""CLI-facing catalog and deterministic linter for Playtest v1.1 assets."""
from __future__ import annotations

from common import EngineError, compile_request, issue, read_json, repository, safe_path


def catalog(command):
    root = repository(command.get("repoRoot"))
    plays_root = safe_path(root, "test-plays")
    plays = []
    issues = []
    for path in sorted(plays_root.glob("*/play.json")) if plays_root.is_dir() else []:
        try:
            path = safe_path(root, str(path), must_exist=True)
            play = read_json(path)
            scenarios = []
            for candidate in sorted(path.parent.glob("*.json")):
                if candidate.name != path.name:
                    candidate = safe_path(root, str(candidate), must_exist=True)
                    scenarios.append(candidate.name)
            plays.append({"slug": path.parent.name, "name": play.get("scenarioName", path.parent.name),
                          "description": play.get("description", ""), "mode": play.get("mode", "explore"),
                          "steps": len(play.get("steps", [])) if isinstance(play.get("steps"), list) else 0,
                          "scenarios": scenarios})
        except EngineError as exc:
            issues.append(issue("error", exc.code, str(exc), path))
    return {"ok": not issues, "repoRoot": str(root), "plays": plays, "issues": issues}


def lint(command):
    try:
        compiled = compile_request(command, discover=True)
        issues = compiled["issues"]
    except (EngineError, OSError, TypeError, ValueError) as exc:
        issues = [issue("error", getattr(exc, "code", "configuration"), str(exc))]
    errors = sum(item["level"] == "error" for item in issues)
    warnings = sum(item["level"] == "warning" for item in issues)
    return {"ok": errors == 0, "errors": errors, "warnings": warnings, "issues": issues}
