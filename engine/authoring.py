"""Business-asset authoring: start a new play, or grow one from a real recorded run.

Two honesty rules drive every choice below:

* Observed behaviour is not intended behaviour. Expectations copied from a run are
  written, but labelled as observations in the play text and in NOTES.md, and the play
  stays `mode: explore` so a draft can never masquerade as an accepted baseline.
* Nothing that failed, was truncated, or was redacted may become an expected value —
  that would launder a defect or a secret into the baseline.
"""
import copy
import json
import hashlib
import re
import unicodedata
from pathlib import Path

from common import (ASSETS, CONFIG, RESERVED, RUNS, EngineError, ensure_assets_ignore,
                    repository, safe_path)

MAX_DRAFT_FIELDS = 8
SECRET_MARKER = "[REDACTED]"
TITLE_LIMIT = 60
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
SAFE_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{6,79}")


def _clean_title(value, fallback):
    title = unicodedata.normalize("NFC", str(value or "")).strip()
    if not title:
        title = fallback
    if len(title) > TITLE_LIMIT:
        title = title[:TITLE_LIMIT].rstrip()
    return title


def derive_slug(title, taken):
    """A kebab-case directory name from a business sentence, without asking the user.

    Latin tokens carry meaning (an interface code, a product name); a Chinese-only title falls back to a short
    hash so paths stay ASCII while the readable title lives in play.json.
    """
    words = [word.lower() for word in re.findall(r"[A-Za-z][A-Za-z0-9]*", str(title or ""))][:4]
    stem = "-".join(words)[:40].rstrip("-") or "play"
    digest = hashlib.sha256(str(title or "").encode("utf-8")).hexdigest()
    for attempt in range(12):
        candidate = stem + "-" + digest[:6 + attempt * 2]
        if candidate not in RESERVED and not taken(candidate):
            return candidate
    raise EngineError("Could not derive a free directory name from that title", "name_collision")


def _write(directory, name, payload):
    (directory / name).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _read_config(root):
    config_path = safe_path(root, CONFIG)
    return json.loads(config_path.read_text(encoding="utf-8")) if config_path.is_file() else {}


def _target_of(root, name):
    config = _read_config(root)
    targets = config.get("targets") or {}
    if name and name not in targets:
        raise EngineError("Unknown target: " + str(name) + "; declare it in " + CONFIG + " first", "unknown_target")
    return config


def _notes(path, lines):
    path.write_text("# 创建说明（自动生成）\n" + "".join(lines), encoding="utf-8")


def create(command):
    """Scaffold a business play from one sentence: a title. Nothing else is required."""
    root = repository(command.get("repoRoot"))
    title_input = _clean_title(command.get("title"), "")
    name = command.get("name")
    if name is None:
        if not title_input:
            raise EngineError("title is required when name is omitted", "invalid_name")
        directory = root / ASSETS
        name = derive_slug(title_input, lambda candidate: (directory / candidate / "play.json").exists())
    elif not isinstance(name, str) or not SLUG.fullmatch(name) or name in RESERVED:
        raise EngineError("name must be a kebab-case slug, not one of " + ", ".join(RESERVED), "invalid_name")
    target = command.get("target")
    inferred = False
    targets = (_read_config(root).get("targets") or {})
    if not target and len(targets) == 1:
        # Exactly one declared service: asking which one to use would be busywork.
        target = next(iter(targets))
        inferred = True
    config = _target_of(root, target)
    directory = ensure_assets_ignore(root) / name
    if directory.exists():
        raise EngineError("Play directory already exists; creating never overwrites assets", "asset_exists")
    title = title_input or _clean_title("", name)
    description = str(command.get("description") or "").strip() or title
    play = {
        "version": 1,
        "scenarioName": title,
        "description": description,
        "mode": "explore",
        "steps": [],
    }
    if target:
        play["target"] = target
    scenario = {
        "version": 1,
        "description": "新建剧本：在这里补变量、造数（setup）、恢复（cleanup）与依赖桩（mocks）。",
        "variables": {},
        "setup": [],
        "cleanup": [],
        "mocks": [],
    }
    directory.mkdir(parents=True)
    _write(directory, "play.json", play)
    _write(directory, "scenario.json", scenario)
    ready = bool((config.get("targets") or {}) if target else (config.get("targets") or {}))
    _notes(directory / "NOTES.md", [
        "\n这个剧本是**空骨架**：插件不知道要验证什么业务，也不猜接口和字段。\n\n",
        "补齐四件事，缺任何一件都不应声称“测过了”：\n\n",
        "1. **要验证的行为**：一句可判定的话，写进 `description`（例：下线后工作站不应继续接单）。\n",
        "2. **依据**：需求、接口契约、已确认的历史案例或明确的业务口径——写进 `claims[].basis`。照抄当前实现只会固化现状。\n",
        "3. **起点**：`scenario.setup` 怎么准备数据；需要改变状态时优先用业务接口，而不是直接写状态表。\n",
        "4. **恢复**：`scenario.cleanup` 怎么把本轮改动还原；还原范围越精确越好。\n\n",
        "断言写好后先以 `mode: explore` 播放观察；确认预期来自业务口径而不是“上次恰好这样”，再改成 `baseline` 或 `acceptance`。\n",
        "" if ready else "\n提示：当前仓库还没有 `.test-plays/config.json` 目标，`target` 未设置；先声明目标才能调用真实服务。\n",
    ])
    return {"ok": True, "slug": name, "title": title, "path": ASSETS + "/" + name,
            "target": target, "targetInferred": inferred,
            "files": ["play.json", "scenario.json", "NOTES.md"],
            "next": "在对话里说一句「把 " + title + " 补成可播放的测试」，由 agent 读代码写步骤与断言"}


def _recorded_steps(root, run_id, snapshot):
    """Prefer result.json; fall back to the event stream for interrupted runs."""
    directory = safe_path(root, RUNS + "/" + run_id)
    result_path = directory / "result.json"
    if result_path.is_file():
        result = json.loads(result_path.read_text(encoding="utf-8"))
        return [step for step in result.get("steps") or [] if isinstance(step, dict)], result
    events = directory / "events.jsonl"
    if not events.is_file():
        raise EngineError("Run artifacts not found: " + run_id, "missing_asset")
    steps = {}
    result = {}
    for line in events.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "step_finished" and isinstance(event.get("step"), dict):
            step = event["step"]
            steps[(step.get("phase"), step.get("play"), step.get("stepNo"))] = step
        if event.get("type") == "run_finished":
            result = event.get("result") or {}
    return list(steps.values()), result


def _pick(recorded, phase, play_slug, number):
    for step in recorded:
        if step.get("phase") == phase and step.get("play") == play_slug and step.get("stepNo") == number:
            return step
    return None


def _data(step):
    evidence = step.get("evidence") or {}
    if isinstance(evidence, dict) and evidence.get("truncated"):
        return None
    return evidence.get("data") if isinstance(evidence, dict) else None


def _draftable(value):
    """Only scalars without redacted content become expectations."""
    if isinstance(value, bool) or isinstance(value, (int, float, str)):
        return SECRET_MARKER not in str(value)
    return False


def _derive_http(data):
    outcome = {}
    skipped = []
    response = (data or {}).get("response") or {}
    status = response.get("status")
    if isinstance(status, int) and 200 <= status < 400:
        outcome["status"] = status
    elif status is not None:
        skipped.append("响应状态 " + str(status) + " 不写成预期（失败响应不应成为基线）")
    body = response.get("body")
    fields = {}
    if isinstance(body, dict):
        for key, value in list(body.items()):
            if len(fields) >= MAX_DRAFT_FIELDS:
                skipped.append("响应字段超过 " + str(MAX_DRAFT_FIELDS) + " 个，未全部转成断言")
                break
            if _draftable(value):
                fields["$." + str(key)] = value
    if fields:
        outcome["json"] = fields
    return outcome, skipped


def _derive_db(data):
    outcome = {}
    skipped = []
    rows = (data or {}).get("rows")
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        return outcome, ["记录行数不是 1，无法安全转成首行断言"]
    for key, value in list(rows[0].items()):
        if len(outcome) >= MAX_DRAFT_FIELDS:
            skipped.append("列超过 " + str(MAX_DRAFT_FIELDS) + " 个，未全部转成断言")
            break
        if _draftable(value):
            outcome[key] = value
    return outcome, skipped


def _draft_step(source, recorded, notes, play_slug, number):
    """Copy the authored step; add expectations only where none existed and the step passed."""
    step = copy.deepcopy(source)
    if recorded is None:
        notes.append((play_slug, number, "未在这次记录中出现", "保持原样，不补断言"))
        return step
    if recorded.get("status") == "failed":
        notes.append((play_slug, number, "该步在这次运行失败", "不采用其响应作为预期；请先判断是缺陷还是预期过时"))
        return step
    data = _data(recorded)
    if data is None:
        notes.append((play_slug, number, "证据被截断", "不据此写断言"))
        return step
    kind = step.get("type", "http")
    if kind == "http":
        derived, skipped = _derive_http(data)
        existing = step.get("expect") if isinstance(step.get("expect"), dict) else {}
        merged = dict(existing)
        if "status" in derived and "status" not in merged:
            merged["status"] = derived["status"]
        json_existing = dict(merged.get("json") or {})
        added = [path for path in derived.get("json", {}) if path not in json_existing]
        json_existing.update({path: derived["json"][path] for path in added})
        if json_existing:
            merged["json"] = json_existing
        if merged:
            step["expect"] = merged
    elif kind in ("dbQuery", "dbWait"):
        derived, skipped = _derive_db(data)
        merged = dict(step.get("expect") or {})
        added = [column for column in derived if column not in merged]
        merged.update({column: derived[column] for column in added})
        if merged:
            step["expect"] = merged
        if not added and not merged:
            skipped = skipped or ["无可转成断言的标量列"]
    elif kind == "mockVerify" and "count" not in step:
        count = data.get("count")
        if isinstance(count, int) and not isinstance(count, bool):
            step["count"] = count
            added, skipped = ["count"], []
        else:
            added, skipped = [], ["无记录调用次数"]
    else:
        added, skipped = [], [kind + " 步骤无需补断言"]
    for check, recorded_check in zip(step.get("checks") or [], recorded.get("checks") or []):
        if check.get("type") in ("dbQuery", "dbWait") and not (check.get("expect") or {}):
            check_data = _data(recorded_check)
            if check_data is None:
                notes.append((play_slug, number, "校验项证据被截断", check.get("name", "")))
                continue
            derived, _ = _derive_db(check_data)
            if derived:
                check["expect"] = derived
                added = list(added) + list(derived)
    if added:
        notes.append((play_slug, number, "写入观察到的预期: " + ", ".join(map(str, added)),
                      "这些值来自那次真实响应/查询，尚未业务确认"))
    for reason in skipped:
        notes.append((play_slug, number, "未补断言", reason))
    return step


def draft(command):
    """Grow a new play out of a recorded run: same steps, plus labelled observations."""
    root = repository(command.get("repoRoot"))
    run_id = command.get("runId")
    # Both identifier shapes exist: the Host uses uuid4 hex, a bare engine run
    # self-generates a timestamped one. Require a safe single path segment and let the
    # artifact check below decide whether the run was actually recorded.
    if not isinstance(run_id, str) or not SAFE_SEGMENT.fullmatch(run_id):
        raise EngineError("runId must be a recorded run identifier", "invalid_run")
    snapshot_path = safe_path(root, RUNS + "/" + run_id + "/snapshot.json")
    if not snapshot_path.is_file():
        raise EngineError("Run snapshot not found: " + run_id, "missing_asset")
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    plays = [item for item in snapshot.get("plays") or [] if isinstance(item, dict)]
    wanted = command.get("play")
    if wanted:
        plays = [item for item in plays if item.get("slug") == wanted]
    if len(plays) != 1:
        raise EngineError("Select one play from this run; found " + str(len(plays)), "invalid_selection")
    source = plays[0]
    # The name comes from what was actually played, so saving a run needs no typing.
    name = command.get("name")
    if name is None:
        stem = str(source.get("slug") or "play") + "-observed"
        signature = hashlib.sha256(run_id.encode("utf-8")).hexdigest()
        for attempt in range(12):
            candidate = stem if attempt == 0 else stem + "-" + signature[:4 + attempt]
            if SLUG.fullmatch(candidate) and candidate not in RESERVED \
                    and not (root / ASSETS / candidate / "play.json").exists():
                name = candidate
                break
        else:
            raise EngineError("Could not derive a free directory name for this draft", "name_collision")
    elif not isinstance(name, str) or not SLUG.fullmatch(name) or name in RESERVED:
        raise EngineError("name must be a kebab-case slug, not one of " + ", ".join(RESERVED), "invalid_name")
    directory = ensure_assets_ignore(root) / name
    if directory.exists():
        raise EngineError("Play directory already exists; creating never overwrites assets", "asset_exists")
    recorded, result = _recorded_steps(root, run_id, snapshot)
    notes = []
    steps = []
    for position, original in enumerate(source.get("play", {}).get("steps") or [], start=1):
        if not isinstance(original, dict):
            continue
        number = original.get("stepNo", position)
        steps.append(_draft_step(original, _pick(recorded, "play", source.get("slug"), number), notes,
                                 source.get("slug"), number))
    title = _clean_title(command.get("title"),
                         str(source.get("play", {}).get("scenarioName") or source.get("slug")) + "（沉淀）")
    origin = "由运行 " + run_id + "（剧本 " + str(source.get("slug")) + "）沉淀"
    play = {
        "version": 1,
        "scenarioName": title,
        "description": (str(source.get("play", {}).get("description") or "").strip() +
                        "\n\n【沉淀】" + origin + "；带标注的预期来自那次真实观察，行为不等于意图，需业务确认后改成 baseline/acceptance。").strip(),
        "mode": "explore",
        "cleanupSeconds": source.get("cleanupSeconds", 30),
        "source": {"kind": "draft", "fromPlay": source.get("slug"), "runId": run_id,
                   "runDigest": result.get("digest"), "originalPreserved": True},
        "claims": copy.deepcopy(source.get("play", {}).get("claims") or []),
        "steps": steps,
    }
    if source.get("target"):
        play["target"] = source["target"]
    scenario = copy.deepcopy(source.get("scenario") or {})
    scenario["version"] = 1
    scenario["description"] = (str(scenario.get("description") or "").strip() +
                               "\n【沉淀】变量、造数、恢复与 mocks 原样复制自 " + str(source.get("slug")) +
                               "，用于复现那次运行的起点与收尾。").strip()
    directory.mkdir(parents=True)
    _write(directory, "play.json", play)
    _write(directory, "scenario.json", scenario)
    drafted = sum(1 for entry in notes if entry[2].startswith("写入观察到的预期"))
    blocked = sum(1 for entry in notes if entry[2] in ("该步在这次运行失败", "证据被截断", "未在这次记录中出现"))
    lines = ["\n来源运行：`" + run_id + "`（快照摘要 `" + str((result.get("digest") or "未知"))[:16] + "`）\n\n",
             "断言来源逐步骤登记如下。**观察到的值不等于业务确认的期望**：\n\n",
             "| 剧本 | 步 | 情况 | 说明 |\n|---|---|---|---|\n"]
    for entry in notes:
        lines.append("| `" + str(entry[0]) + "` | " + str(entry[1]) + " | " + str(entry[2]) + " | " + str(entry[3]) + " |\n")
    lines.append("\n共 " + str(drafted) + " 步写入了观察到的预期，" + str(blocked) +
                 " 步未采用（失败/截断/未记录）。\n\n")
    lines.append("下一步：逐条确认这些值是不是业务口径。确认后把 `play.json` 的 `mode` 改为 `baseline`（与已记录预期比较）"
                 "或 `acceptance`（按已确认规则验收，并补 `claims[].basis`）。\n")
    _notes(directory / "NOTES.md", lines)
    return {"ok": True, "slug": name, "path": ASSETS + "/" + name, "fromPlay": source.get("slug"),
            "runId": run_id, "stepCount": len(steps), "draftedSteps": drafted, "unadoptedSteps": blocked,
            "files": ["play.json", "scenario.json", "NOTES.md"],
            "next": "逐条核对 NOTES.md 里的观察值，确认后调整 mode 与断言"}
