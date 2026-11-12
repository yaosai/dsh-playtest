"""CLI-facing catalog and deterministic linter for Playtest v1 assets."""
from __future__ import annotations

from common import (ASSETS, CONFIG, LEGACY_ASSETS, LEGACY_RUNS, RESERVED, EngineError, compile_request,
                    issue, read_json, repository, safe_path)

# Asset directories are never candidate repositories: descending into them only wastes
# the bounded scan and could surface a copied fixture that looks like a project.
SKIP_DIRS = {"node_modules", "target", "build", "dist", "out", "__pycache__", ".venv", "venv",
             ASSETS, LEGACY_ASSETS, LEGACY_RUNS}
MAX_CANDIDATES = 24
MAX_REPOS = 40
MAX_SCAN_ENTRIES = 600


def count_plays(directory):
    plays_dir = directory / ASSETS
    return sum(1 for entry in plays_dir.glob("*/play.json") if entry.parent.name not in RESERVED
               ) if plays_dir.is_dir() else 0


def git_repositories(root, max_depth=3):
    """Bounded read-only discovery of Git working trees under one workspace root.

    Stops descending at a repository so vendored or nested copies are not offered.
    Symlinks and anything resolving outside the requested root are ignored.
    """
    found = []
    budget = [MAX_SCAN_ENTRIES]

    def walk(directory, depth):
        try:
            entries = sorted(directory.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for entry in entries:
            if len(found) >= MAX_REPOS or budget[0] <= 0:
                return
            budget[0] -= 1
            try:
                if entry.is_symlink() or not entry.is_dir():
                    continue
                if entry.name.startswith(".") or entry.name in SKIP_DIRS:
                    continue
                if not entry.resolve().is_relative_to(root):
                    continue
                is_repo = (entry / ".git").exists()
            except OSError:
                continue
            if is_repo:
                found.append(entry)
            elif depth < max_depth:
                walk(entry, depth + 1)

    if (root / ".git").exists():
        found.append(root)
    else:
        walk(root, 1)
    return found


def repositories(command):
    """Git working trees a user can pick; each one owns <repo>/.test-plays."""
    root = repository(command.get("repoRoot"))
    items = []
    for path in git_repositories(root):
        relative = "." if path == root else str(path.relative_to(root))
        items.append({"path": str(path), "relative": relative, "name": path.name,
                      "plays": count_plays(path)})
    items.sort(key=lambda item: (item["plays"] == 0, item["relative"].lower()))
    return {"ok": True, "root": str(root), "repositories": items}


def nearby_repos(root):
    """Bounded read-only scan for nested directories that hold their own .test-plays.

    A multi-repository workspace root usually has no plays itself; surfacing the
    child repositories avoids asking users to retype absolute paths. Symlinks and
    anything resolving outside the requested root are ignored.
    """
    found, seen, visited = [], set(), 0
    frontier = [root]
    for _depth in range(2):
        descend = []
        for directory in frontier:
            try:
                entries = sorted(directory.iterdir(), key=lambda p: p.name.lower())
            except OSError:
                continue
            for entry in entries:
                visited += 1
                if visited > MAX_SCAN_ENTRIES:
                    return found
                try:
                    if entry.is_symlink() or not entry.is_dir():
                        continue
                    if entry.name.startswith(".") or entry.name in SKIP_DIRS:
                        continue
                    if not entry.resolve().is_relative_to(root):
                        continue
                    plays_dir = entry / ASSETS
                    count = sum(1 for hit in plays_dir.glob("*/play.json")
                                if hit.parent.name not in RESERVED) if plays_dir.is_dir() else 0
                except OSError:
                    continue
                if count:
                    key = str(entry)
                    if key not in seen:
                        seen.add(key)
                        found.append({"repoRoot": key, "plays": count})
                    if len(found) >= MAX_CANDIDATES:
                        return found
                    continue
                descend.append(entry)
        frontier = descend
    return found


def catalog(command):
    root = repository(command.get("repoRoot"))
    # The picker offers what the repository actually declares, so nobody types a file or
    # target name from memory.
    config_path = safe_path(root, CONFIG)
    config = read_json(config_path) if config_path.is_file() else {}
    plays_root = safe_path(root, ASSETS)
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
                          "scenarios": scenarios,
                          "defaultScenario": play.get("scenario") if isinstance(play.get("scenario"), str) else "scenario.json"})
        except EngineError as exc:
            issues.append(issue("error", exc.code, str(exc), path))
    result = {"ok": not issues, "repoRoot": str(root), "plays": plays, "issues": issues,
              "targets": sorted((config.get("targets") or {}).keys())}
    if not plays:
        candidates = nearby_repos(root)
        if candidates:
            result["repoCandidates"] = candidates
    return result



def lint(command):
    try:
        compiled = compile_request(command, discover=True)
        issues = compiled["issues"]
    except (EngineError, OSError, TypeError, ValueError) as exc:
        issues = [issue("error", getattr(exc, "code", "configuration"), str(exc))]
    errors = sum(item["level"] == "error" for item in issues)
    warnings = sum(item["level"] == "warning" for item in issues)
    return {"ok": errors == 0, "errors": errors, "warnings": warnings, "issues": issues}
